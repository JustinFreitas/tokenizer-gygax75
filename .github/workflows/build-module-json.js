var fs = require('fs');

const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;

var mod = JSON.parse(fs.readFileSync('module-template.json', 'utf8'));

mod.version = version;
mod.download = `https://github.com/JustinFreitas/tokenizer-gygax75/releases/download/v${version}/vtta-tokenizer.zip`;

console.log(JSON.stringify(mod, null, 2));
