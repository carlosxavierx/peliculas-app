const http = require('http');
const server = http.createServer((req, res) => res.end('ok'));
server.listen(8089, '0.0.0.0', () => {
    console.log('listening on', server.address());
});
setTimeout(() => {}, 60000);