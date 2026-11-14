FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43
# Fixed nonbilling fixture response. No model, credentials or external requests.
USER 65534:65534
CMD ["node", "--input-type=module", "-e", "import http from 'node:http';http.createServer((req,res)=>{req.resume();res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({fixture:'lyrashield-synthetic-provider/1'}))}).listen(8080,'0.0.0.0');"]
