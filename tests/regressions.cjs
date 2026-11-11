const assert = require("assert").strict;
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const flatten = (object, prefix = "", result = {}) => {
  for (const [key, value] of Object.entries(object)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "object") flatten(value, full, result);
    else result[full] = value;
  }
  return result;
};
const en = flatten(JSON.parse(read("lang/en.json")));
const ru = flatten(JSON.parse(read("lang/ru.json")));
const hooks = new Map();
const hookModes = new Map();
const notifications = [];
const registeredSettings = new Map();
const registeredMenus = new Map();
const windowListeners = new Map();
const settings = new Map(Object.entries({
  "log-level": "OFF",
  "title-link": true,
  "default-frame-npc": "[data] frame.png",
  "default-frame-neutral": "[data] frame.png",
  "default-frame-pc": "[data] frame.png",
  "default-frame-tint": "[data] frame.png",
  "default-mask-layer": "[data] mask.png",
  "custom-frames": [],
  "custom-masks": [],
  "image-save-type": "webp",
  "token-only-toggle": true,
  "reset-scaling": false,
  "npc-image-upload-directory": "[data] tokenizer/npc-images",
}));
let latestApp;

class Actor {
  constructor(data = {}) {
    Object.assign(this, data);
  }
}

class ApplicationV2 {
  constructor(options = {}) {
    this.options = options;
    latestApp = this;
  }

  render() {}

  async _onClose(_options) {}
}

class DialogV2 extends ApplicationV2 {
  constructor(options = {}) {
    super(options);
    this._listeners = new Map();
    DialogV2.instances.push(this);
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }

  render(options) {
    this.renderedWith = options;
    return this;
  }

  static instances = [];

  static async prompt(options = {}) {
    const instance = new DialogV2(options);
    instance.addEventListener("close", () => {});
    instance.render({ force: true });
    if (DialogV2.nextPromptValue !== undefined && options.ok?.callback) {
      return options.ok.callback({}, {
        form: { elements: { tokenizerurl: { value: DialogV2.nextPromptValue } } },
      });
    }
    return DialogV2.nextPromptValue ?? null;
  }
}

class FilePicker {
  constructor(options) {
    this.options = options;
    FilePicker.last = this;
  }

  static async upload() {
    return { path: "tokenizer/token.webp" };
  }

  static async createDirectory() {}

  static async browse() {
    return { files: [] };
  }

  render(options) {
    this.renderedWith = options;
  }
}

const mockWindow = {
  isSecureContext: false,
  location: { reloadCalled: 0, reload() { this.reloadCalled += 1; } },
  addEventListener(type, fn) {
    if (!windowListeners.has(type)) windowListeners.set(type, new Set());
    windowListeners.get(type).add(fn);
  },
  removeEventListener(type, fn) {
    windowListeners.get(type)?.delete(fn);
  },
  dispatch(type, event) {
    for (const fn of [...(windowListeners.get(type) ?? [])]) {
      fn(event);
    }
  },
};

const context = vm.createContext({
  console,
  setTimeout,
  clearTimeout,
  TextEncoder,
  Actor,
  CONFIG: {
    Actor: {
      sheetClasses: {
        character: {
          "ose.OseActorSheetCharacter": { cls: class OseActorSheetCharacter {} },
        },
      },
    },
  },
  window: mockWindow,
  File: class File {
    constructor(data, name, options) {
      this.data = data;
      this.name = name;
      this.type = options.type;
    }
  },
  Hooks: {
    on: (name, callback) => {
      hooks.set(name, callback);
      hookModes.set(name, "on");
    },
    once: (name, callback) => {
      hooks.set(name, callback);
      hookModes.set(name, "once");
    },
  },
  foundry: {
    applications: {
      api: {
        ApplicationV2,
        DialogV2,
        HandlebarsApplicationMixin: (base) => base,
      },
      apps: { FilePicker: { implementation: FilePicker } },
    },
    utils: {
      debounce: (fn) => (...args) => fn(...args),
      getProperty: (object, key) => key.split(".").reduce((value, part) => value?.[part], object),
      setProperty: (object, key, value) => {
        const parts = key.split(".");
        const last = parts.pop();
        const parent = parts.reduce((target, part) => target[part] ?? (target[part] = {}), object);
        parent[last] = value;
      },
    },
  },
  game: {
    system: { id: "ose" },
    user: { isGM: true, can: () => true },
    modules: new Map([["vtta-tokenizer", {}]]),
    canvas: { layers: [] },
    settings: {
      get: (_module, key) => settings.get(key) ?? false,
      set: async (_module, key, val) => settings.set(key, val),
      register: (_module, key, data) => registeredSettings.set(key, data),
      registerMenu: (_module, key, data) => registeredMenus.set(key, data),
      settings: { get: () => ({ default: "[data] frame.png" }) },
    },
    i18n: {
      localize: (key) => ru[key] ?? key,
      format: (key, values) => (ru[key] ?? key).replace(/\{([^}]+)\}/g, (_match, name) => values[name]),
    },
  },
  ui: {
    notifications: {
      warn: (message) => notifications.push(message),
      error: (message) => notifications.push(message),
    },
  },
  canvas: { ready: false },
});
const modules = new Map();

function load(filename) {
  const absolute = path.resolve(root, filename);
  if (!modules.has(absolute)) {
    modules.set(absolute, new vm.SourceTextModule(fs.readFileSync(absolute, "utf8"), {
      context,
      identifier: absolute,
    }));
  }
  return modules.get(absolute);
}

let passed = 0;

async function check(name, run) {
  await run();
  passed += 1;
  console.log(`PASS ${name}`);
}

async function main() {
  const entry = load("src/hooks.js");
  await entry.link((specifier, reference) => load(path.resolve(path.dirname(reference.identifier), specifier)));
  await entry.evaluate();
  const hooksNs = entry.namespace;
  const DirectoryPicker = load("src/libs/DirectoryPicker.js").namespace.default;
  const ImageBrowser = load("src/libs/ImageBrowser.js").namespace.default;
  const Utils = load("src/libs/Utils.js").namespace.default;
  const Tokenizer = load("src/tokenizer/Tokenizer.js").namespace.default;
  const AutoTokenize = load("src/tokenizer/AutoTokenize.js").namespace.default;
  const SaveLocations = load("src/libs/TokenizerSaveLocations.js").namespace.TokenizerSaveLocations;
  const CONSTANTS = load("src/constants.js").namespace.default;
  const directory = "tokenizer/npc-images/Таков замысел";
  const encoded = encodeURI(directory);
  const blob = { type: "image/webp" };

  hooksNs.init();

  await check("encoded and raw Cyrillic directories resolve to the same local path", () => {
    for (const value of [directory, encoded, `[data] ${encoded}`]) {
      assert.equal(DirectoryPicker.parse(value).current, directory);
    }
    assert.equal(DirectoryPicker.parse(`[public] ${encoded}`).current, directory);
    assert.equal(DirectoryPicker.parse("[data] tokenizer/100%/%D0%A2").current, "tokenizer/100%/Т");
    assert.equal(DirectoryPicker.parse("[data] tokenizer/%E0%A4%A").current, "tokenizer/%E0%A4%A");
    assert.equal(DirectoryPicker.parse("[data] tokenizer/%2520").current, "tokenizer/%20");
  });

  await check("S3, Forge and external URL paths retain their provider spelling", () => {
    assert.equal(DirectoryPicker.parse(`[s3:bucket] ${encoded}`).current, encoded);
    assert.equal(DirectoryPicker.parse(`[s3:bucket] ${encoded}`).bucket, "bucket");
    assert.equal(DirectoryPicker.parse(`[forgevtt] ${encoded}`).current, encoded);
    const url = "https://example.org/Токен%20image?sig=a%2Fb";
    assert.equal(DirectoryPicker.parse(url).current, url);
  });

  await check("upload receives a filesystem path and the Cyrillic filename intact", async () => {
    let received;
    FilePicker.upload = async (...args) => {
      received = args;
      return { path: `${encoded}/Токен.webp` };
    };
    const result = await Utils.uploadToFoundry(blob, `[data] ${encoded}`, "Токен.webp");
    assert.equal(received[0], "data");
    assert.equal(received[1], directory);
    assert.equal(received[2].name, "Токен.webp");
    assert.equal(result, `${encoded}/Токен.webp`);
    await DirectoryPicker.uploadToPath(`[data] ${encoded}`, received[2]);
    assert.equal(received[1], directory);
  });

  await check("missing, empty and error upload responses throw a translated error", async () => {
    for (const response of [undefined, null, {}, { path: "" }, { path: " " }, {
      error: "failed",
      path: "old.webp",
    }]) {
      FilePicker.upload = async () => response;
      await assert.rejects(Utils.uploadToFoundry(blob, `[data] ${encoded}`, "Токен.webp"), /Не удалось сохранить/);
    }
  });

  await check("directory verification creates Cyrillic nested folders without skipping repeated names", async () => {
    const created = [];
    FilePicker.createDirectory = async (_source, target) => {
      created.push(target);
    };
    assert.equal(await DirectoryPicker.verifyPath(DirectoryPicker.parse(`[data] ${encoded}/Таков замысел`)), true);
    assert.deepEqual(created, ["tokenizer", "tokenizer/npc-images", directory, `${directory}/Таков замысел`]);
    created.length = 0;
    await DirectoryPicker.verifyPath(DirectoryPicker.parse("[data] tokenizer/%2520"));
    assert.deepEqual(created, ["tokenizer", "tokenizer/%20"]);
  });

  await check("existing directories are accepted; inaccessible directories fail validation", async () => {
    FilePicker.createDirectory = async () => {
      throw new Error("EEXIST: already exists");
    };
    assert.equal(await DirectoryPicker.verifyPath(DirectoryPicker.parse(`[data] ${encoded}`)), true);
    FilePicker.createDirectory = async () => {
      throw new Error("Папка уже существует");
    };
    FilePicker.browse = async () => ({ files: [] });
    assert.equal(await DirectoryPicker.verifyPath(DirectoryPicker.parse(`[data] ${encoded}`)), true);
    FilePicker.browse = async () => {
      throw new Error("EACCES");
    };
    assert.equal(await DirectoryPicker.verifyPath(DirectoryPicker.parse(`[data] ${encoded}`)), false);
  });

  await check("local image URLs are encoded exactly once", async () => {
    assert.equal(await DirectoryPicker.getFileUrl(`[data] ${encoded}`, "Токен.webp"), encodeURI(`${directory}/Токен.webp`));
  });

  await check("folder picker receives the decoded directory and storage source", async () => {
    const input = {};
    const app = {
      tokenizer: { tokenUploadDirectory: `[data] ${encoded}` },
      element: { querySelector: () => input },
    };
    await SaveLocations.selectDirectory.call(app, {}, { dataset: { target: "tokenUploadDirectory" } });
    assert.equal(FilePicker.last.options.current, directory);
    assert.equal(FilePicker.last.options.activeSource, "data");
    assert.equal(FilePicker.last.renderedWith?.force, true);
    await FilePicker.last.options.callback(encoded, { activeSource: "data" });
    assert.equal(DirectoryPicker.parse(input.value).current, directory);
    app.tokenizer.tokenUploadDirectory = `[s3:bucket] ${encoded}`;
    await SaveLocations.selectDirectory.call(app, {}, { dataset: { target: "tokenUploadDirectory" } });
    assert.equal(FilePicker.last.options.bucket, "bucket");
    assert.equal(FilePicker.last.options.current, encoded);
  });

  await check("wildcard generation browses a decoded Cyrillic path", async () => {
    let target;
    FilePicker.browse = async (_source, value) => {
      target = value;
      return { files: ["one", "two"] };
    };
    const filename = await Tokenizer.prototype._getFilename.call({
      tokenOptions: {
        name: "Таков замысел",
        isWildCard: true,
        tokenFilename: `${encoded}/${encodeURIComponent("Токен")}*.webp`,
      },
      wildCardPath: encoded,
      imageFormat: "webp",
    }, "Token");
    assert.equal(target, `${directory}/Токен*.webp`);
    assert.equal(filename, "Токен003.webp");
  });

  const updates = [];
  const actor = new Actor({
    _id: "actor123456789012",
    name: "Таков замысел",
    type: "npc",
    img: "старый-портрет.webp",
    prototypeToken: {
      disposition: -1,
      randomImg: false,
      texture: { src: "старый-токен.webp" },
    },
    update: async (data) => {
      updates.push(JSON.parse(JSON.stringify(data)));
    },
  });
  const buttons = [];
  hooks.get("getActorSheetHeaderButtons")({ document: actor }, buttons);
  buttons[0].onclick();
  const actorCallback = latestApp.callback;

  await check("actor update accepts a token without an avatar and resets offsetX & offsetY when reset-scaling is enabled", async () => {
    updates.length = 0;
    settings.set("reset-scaling", true);
    await actorCallback({
      actor,
      tokenFilename: `${encoded}/Токен.webp`,
    });
    settings.set("reset-scaling", false);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].img, undefined);
    assert.ok(updates[0].prototypeToken.texture.src.startsWith(`${encoded}/Токен.webp?`));
    assert.equal(updates[0].prototypeToken.texture.offsetX, 0);
    assert.equal(updates[0].prototypeToken.texture.offsetY, 0);
  });

  await check("empty filenames never overwrite actor images", async () => {
    updates.length = 0;
    await actorCallback({ actor });
    await actorCallback({
      actor,
      avatarFilename: "",
      tokenFilename: " ",
    });
    assert.equal(updates.length, 0);
  });

  await check("avatar-only and wildcard updates preserve token paths", async () => {
    updates.length = 0;
    await actorCallback({
      actor,
      avatarFilename: "Портрет.webp?old",
      isWildCard: true,
      tokenFilename: "Токен*.webp",
    });
    assert.ok(updates[0].img.startsWith("Портрет.webp?"));
    assert.equal(updates[0].prototypeToken, undefined);
  });

  const form = {
    Avatar: { get: async () => blob },
    Token: { get: async () => blob },
    modifyAvatar: true,
    modifyToken: true,
    avatarUploadDirectory: `[data] ${encoded}`,
    tokenUploadDirectory: `[data] ${encoded}`,
    avatarFileName: "Портрет.webp",
    tokenFileName: "Токен.webp",
    tokenOptions: {
      actor,
      avatarFilename: actor.img,
      tokenFilename: actor.prototypeToken.texture.src,
    },
    updateAvatar: Tokenizer.prototype.updateAvatar,
    updateToken: Tokenizer.prototype.updateToken,
    callback: actorCallback,
  };

  await check("failed token upload stops form submission before actor update", async () => {
    updates.length = 0;
    FilePicker.upload = async (_source, _directory, file) => (file.name === "Портрет.webp" ? { path: "Портрет.webp" } : {});
    await assert.rejects(Tokenizer.formHandler.call(form), /Не удалось сохранить/);
    assert.equal(updates.length, 0);
  });

  await check("successful submission awaits actor update", async () => {
    FilePicker.upload = async (_source, _directory, file) => ({ path: `${encoded}/${file.name}` });
    let finished = false;
    form.callback = async (response) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await actorCallback(response);
      finished = true;
    };
    await Tokenizer.formHandler.call(form);
    assert.equal(finished, true);
    assert.ok(updates[0].img.startsWith(`${encoded}/Портрет.webp?`));
    assert.ok(updates[0].prototypeToken.texture.src.startsWith(`${encoded}/Токен.webp?`));
  });

  await check("callback errors propagate to form submission", async () => {
    form.callback = async () => {
      throw new Error("Actor update failed");
    };
    await assert.rejects(Tokenizer.formHandler.call(form), /Actor update failed/);
  });

  await check("Tokenizer window paste/drop listeners do not stack on re-render and are removed on _onClose", async () => {
    const app = new Tokenizer({ name: "Goblin", type: "npc", disposition: -1 }, () => {});
    app.loadImages = () => {};
    app.element = {
      dataset: {},
      addEventListener() {},
    };
    let pasted = 0;
    app.pasteImage = () => { pasted += 1; };

    app._onRender();
    app._onRender();
    assert.equal(windowListeners.get("paste").size, 1);
    assert.equal(windowListeners.get("drop").size, 1);

    let stopped = false;
    mockWindow.dispatch("paste", { stopPropagation() { stopped = true; } });
    assert.equal(stopped, true);
    assert.equal(pasted, 1);

    await app._onClose({});
    assert.equal(windowListeners.get("paste").size, 0);
    assert.equal(windowListeners.get("drop").size, 0);
  });

  await check("DialogV2 and ApplicationV2 dialogs include ['ose', 'dialog'] classes and explicit numeric/auto position", async () => {
    DialogV2.instances.length = 0;
    await AutoTokenize._renderCompleteDialog("Done", { title: "Pack", description: "Updated 3" });
    assert.equal(DialogV2.instances.length, 1);
    assert.ok(DialogV2.instances[0].options.classes.includes("ose"));
    assert.ok(DialogV2.instances[0].options.classes.includes("dialog"));
    assert.equal(DialogV2.instances[0].options.position.width, 400);
    assert.equal(DialogV2.instances[0].options.position.height, "auto");

    DialogV2.instances.length = 0;
    DialogV2.nextPromptValue = null;
    await Tokenizer.menuButton.call(
      { Avatar: {}, Token: {} },
      { preventDefault() {} },
      { dataset: { target: "token", type: "download" } },
    );
    assert.equal(DialogV2.instances.length, 1);
    assert.deepEqual([...DialogV2.instances[0].options.classes], ["ose", "dialog"]);
    assert.equal(DialogV2.instances[0].options.position.width, 400);
    assert.equal(DialogV2.instances[0].options.position.height, "auto");

    assert.ok(AutoTokenize.DEFAULT_OPTIONS.classes.includes("ose"));
    assert.ok(AutoTokenize.DEFAULT_OPTIONS.classes.includes("dialog"));
    assert.equal(AutoTokenize.DEFAULT_OPTIONS.position.height, "auto");

    assert.ok(SaveLocations.DEFAULT_OPTIONS.classes.includes("ose"));
    assert.ok(SaveLocations.DEFAULT_OPTIONS.classes.includes("dialog"));
    assert.equal(SaveLocations.DEFAULT_OPTIONS.position.width, 500);

    for (const menuKey of ["quick-settings", "reset-custom-masks", "reset-custom-frames"]) {
      const MenuCls = registeredMenus.get(menuKey).type;
      assert.ok(MenuCls.DEFAULT_OPTIONS.classes.includes("ose"), menuKey);
      assert.ok(MenuCls.DEFAULT_OPTIONS.classes.includes("dialog"), menuKey);
      assert.equal(typeof MenuCls.DEFAULT_OPTIONS.position.width, "number", menuKey);
      assert.equal(MenuCls.DEFAULT_OPTIONS.position.height, "auto", menuKey);
    }
  });

  await check("Foundry V14 context menu hooks use Hooks.on, V2 header respects title-link & doc.token, ImageBrowser handles undefined result, and image settings use filePicker", async () => {
    assert.equal(hookModes.get("getActorContextOptions"), "on");
    assert.equal(hookModes.get("getCompendiumContextOptions"), "on");
    assert.equal(hooks.has("getActorDirectoryEntryContext"), false);
    assert.equal(hooks.has("getCompendiumDirectoryEntryContext"), false);

    settings.set("title-link", false);
    const v2ButtonsDisabled = [];
    const configDisabled = { document: actor, options: { actions: {} } };
    hooks.get("getHeaderControlsApplicationV2")(configDisabled, v2ButtonsDisabled);
    assert.equal(v2ButtonsDisabled.length, 0);

    settings.set("title-link", true);
    const tokenActor = new Actor({
      _id: "actor999999999999",
      name: "Skeleton",
      type: "npc",
      img: "skeleton.webp",
      token: { _id: "tok12345678901234", name: "Skeleton #1", disposition: -1, texture: { src: "skeleton-tok.webp" } },
      prototypeToken: { disposition: -1, randomImg: false, texture: { src: "skeleton-proto.webp" } },
    });
    const v2ButtonsEnabled = [];
    const configEnabled = { document: tokenActor, options: { actions: {} } };
    hooks.get("getHeaderControlsApplicationV2")(configEnabled, v2ButtonsEnabled);
    assert.equal(v2ButtonsEnabled.length, 1);
    configEnabled.options.actions.tokenizer.call({ document: tokenActor });
    assert.equal(latestApp.tokenOptions.token._id, "tok12345678901234");
    assert.equal(latestApp.tokenOptions.actor, tokenActor);

    let pickedPath = null;
    await ImageBrowser.openFilePicker.call(
      { callback: (p) => { pickedPath = p; }, close() {} },
      { preventDefault() {} },
    );
    FilePicker.last.options.callback("tokens/orc.webp", { activeSource: "data", result: undefined });
    assert.equal(pickedPath, "[data] tokens/orc.webp");

    for (const key of [
      "default-frame-pc",
      "default-frame-npc",
      "default-frame-neutral",
      "default-frame-tint",
      "default-texture-layer",
      "default-mask-layer",
    ]) {
      const cfg = registeredSettings.get(key);
      assert.equal(cfg.type?.name, "String", key);
      assert.equal(cfg.filePicker, "image", key);
    }

    hooksNs.ready();
    let clickBindings = 0;
    const avatarEl = {
      dataset: {},
      addEventListener() { clickBindings += 1; },
    };
    const rootEl = { querySelector: () => avatarEl };
    hooks.get("renderOseActorSheetCharacter")({ document: actor }, rootEl, {});
    hooks.get("renderOseActorSheetCharacter")({ document: actor }, rootEl, {});
    assert.equal(clickBindings, 1);

    const omfg = Tokenizer.prototype.getOMFGFrames.call({ frames: [], omfgFrames: [] });
    assert.ok(omfg.some((f) => f.key.includes("/desaturated/") && f.label.includes("(")));
  });

  await check("Russian translations cover English keys and preserve interpolation", () => {
    assert.deepEqual(Object.keys(ru).sort(), Object.keys(en).sort());
    for (const [key, value] of Object.entries(en)) {
      assert.ok(ru[key].trim(), key);
      const placeholders = (text) => (text.match(/\{[^}]+\}/g) ?? []).sort();
      assert.deepEqual(placeholders(ru[key]), placeholders(value), key);
    }
    for (const mode of Object.values(CONSTANTS.BLEND_MODES)) assert.ok(ru[`vtta-tokenizer.blend.${mode}`]);
    for (const file of ["module-template.json", "module-dev.json"]) {
      const manifest = JSON.parse(read(file));
      assert.ok(manifest.languages.some((language) => language.lang === "ru" && language.path === "lang/ru.json"));
      assert.equal(manifest.id, "vtta-tokenizer");
    }
  });

  for (const filename of fs.readdirSync(path.join(root, "lang")).filter((name) => name.endsWith(".json")).sort()) {
    await check(`language ${filename}: translations and English fallback`, () => {
      const translated = flatten(JSON.parse(read(`lang/${filename}`)));
      for (const [key, value] of Object.entries(translated)) {
        assert.equal(typeof value, "string", `${filename}: ${key}`);
        assert.ok(value.trim(), `${filename}: ${key} is empty`);
      }
      let fallbacks = 0;
      for (const [key, english] of Object.entries(en)) {
        const value = translated[key] ?? english;
        if (translated[key] === undefined) fallbacks += 1;
        assert.ok(value.trim(), `${filename}: ${key} has no translation or fallback`);
        const placeholders = (text) => (text.match(/\{[^}]+\}/g) ?? []).sort();
        assert.deepEqual(placeholders(value), placeholders(english), `${filename}: ${key}`);
      }
      console.log(`  ${filename}: ${fallbacks} missing keys use English fallback`);
    });
  }

  await check("UI localization calls resolve to translated keys", () => {
    function inspect(dir) {
      for (const item of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const filename = path.join(dir, item.name);
        if (item.isDirectory()) inspect(filename);
        else if (/\.(js|hbs)$/.test(item.name)) {
          const source = read(filename).replace(/\$\{CONSTANTS\.MODULE_ID\}/g, "vtta-tokenizer");
          for (const match of source.matchAll(/(?:localize|format)\(?\s*["'`]((?:vtta-tokenizer)\.[A-Za-z0-9.-]+)["'`]/g)) {
            assert.ok(ru[match[1]], `${filename}: ${match[1]}`);
          }
          for (const match of source.matchAll(/title:\s*"(vtta-tokenizer\.[A-Za-z0-9.-]+)"/g)) assert.ok(ru[match[1]], match[1]);
        }
      }
    }

    inspect("src");
    inspect("templates");
  });

  console.log(`${passed} regression checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
