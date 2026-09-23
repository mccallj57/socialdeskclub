import { build } from "esbuild";
import { mkdir, copyFile, writeFile } from "node:fs/promises";
await mkdir("dist/public",{recursive:true});
await build({entryPoints:["client/src/main.jsx"],bundle:true,minify:true,outfile:"dist/public/app.js",jsx:"automatic",define:{"process.env.NODE_ENV":'"production"'}});
await copyFile("client/index.html","dist/public/index.html");
await writeFile("dist/public/config.js",'window.WRITES_CONFIG = {mode:"preview", apiBase:"__PORT_8110__"};\n');
console.log("Built Writes preview.");
