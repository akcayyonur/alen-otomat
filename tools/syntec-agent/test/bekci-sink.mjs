// Bekci testi icin sahte backend (bekci-test.ps1 kullanir): ingest kabul eder, tezgah listesi
// verir (127.0.0.1 ve 127.0.0.2: sahte Syntec DLL'i IP'ye bakmaz), paket sayacini /count'ta verir.
import http from 'node:http';

const PORT = Number(process.argv[2] || 39555);
let posts = 0;
// Tezgah listesi test sirasinda degistirilebilir: GET /set?list=CNC-01:127.0.0.1,CNC-03:127.0.0.3
let machines = [{ id: 'CNC-01', ip: '127.0.0.1' }, { id: 'CNC-02', ip: '127.0.0.2' }];
http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/api/ingest')) {
    req.on('data', () => {});
    req.on('end', () => { posts++; res.writeHead(200); res.end('{}'); });
  } else if (req.url.startsWith('/api/agent/machines')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ machines }));
  } else if (req.url.startsWith('/set?list=')) {
    machines = decodeURIComponent(req.url.slice('/set?list='.length)).split(',').filter(Boolean).map((x) => { const [id, ip] = x.split(':'); return { id, ip }; });
    res.end('ok');
  } else if (req.url === '/count') {
    res.end(String(posts));
  } else {
    res.writeHead(404); res.end();
  }
}).listen(PORT, '127.0.0.1', () => console.log('sink hazir: ' + PORT));
