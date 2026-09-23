import {build} from "esbuild";
import {mkdir,cp,writeFile,readFile} from "node:fs/promises";
import JSZip from "jszip";
await mkdir("release/lambda",{recursive:true});
await build({entryPoints:["server/aws.mjs"],bundle:true,platform:"node",target:"node24",format:"cjs",outfile:"release/lambda/index.js",external:["@aws-sdk/*"],minify:true});
const zip=new JSZip();zip.file("index.js",await readFile("release/lambda/index.js"));await writeFile("release/writes-api.zip",await zip.generateAsync({type:"nodebuffer",compression:"DEFLATE"}));
await cp("dist/public","release/frontend",{recursive:true});
await writeFile("release/frontend/config.js",`// Replace this endpoint after deploying the Writes stack. Never use the Reads API here.\nwindow.WRITES_CONFIG = {mode:"production",apiBase:"REPLACE_WITH_WRITES_API_ENDPOINT",authBase:"https://i0u0tcrbfb.execute-api.us-west-2.amazonaws.com"};\n`);
await cp("deploy/writes-stack.yaml","release/writes-stack.yaml");
const before=await readFile("deploy/homepage-before-writes.html","utf8");
const marker='      <a href="/camp/index.html" class="project-card">';
if(!before.includes(marker)||before.includes('href="/writes/'))throw new Error("Homepage changed or already contains Writes. Review before preparing an integration copy.");
const card=`      <a href="/writes/index.html" class="project-card">
        <span class="project-icon"><svg aria-label="Writes pen mark" width="40" height="40" viewBox="0 0 32 32" fill="none"><path d="M8 25 10 13 23 5 27 9 19 22 8 25ZM8 25 17 16M12 11l9 9M5 28h21" stroke="currentColor" stroke-width="1.5"/><circle cx="18" cy="15" r="2" stroke="currentColor" stroke-width="1.5"/></svg></span>
        <h2>Writes</h2>
        <p>A home for your words. Bring in your posts, preserve your poems, and turn your writing into little books.</p>
        <span class="project-tag">Member library</span>
      </a>
`;
await mkdir("release/homepage",{recursive:true});
await writeFile("release/homepage/index.html",before.replace(marker,card+marker));
await cp("deploy/homepage-before-writes.html","release/homepage/index-before-writes.html");
console.log("Built isolated AWS release candidate. No AWS resources were changed.");
