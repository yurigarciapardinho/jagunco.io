import fs from "node:fs";
import { fileURLToPath } from "node:url";

const client = fs.readFileSync(fileURLToPath(new URL("./client-cave.js", import.meta.url)), "utf8");

export function patchCaveClient(source) {
    const changes = [
        ['function $p(e){', client + '\nfunction $p(e){if(e.cave!==undefined)jaguncoCave=e.cave;'],
        ['P.globalAlpha=1,P.strokeStyle=Ws,Xg(c,l)',
         'P.globalAlpha=1,drawJaguncoCave(P,c,l,fe,pe),P.strokeStyle=Ws,Xg(c,l)']
    ];
    for (const [from, to] of changes) {
        const count = source.split(from).length - 1;
        if (count !== 1) throw new Error("cave client anchor matched " + count + " times (expected 1): " + from);
        source = source.replace(from, () => to);
    }
    return source;
}
