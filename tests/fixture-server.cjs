// Isolated UI fixture: no real TelDrive, aria2, settings, or local files are used.
// Run: node tests/fixture-server.cjs, then open http://127.0.0.1:15300.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const GB = 1024 ** 3, MB = 1024 ** 2;
const file = (name, size, prefix = '') => ({ name, path: `${prefix}/${name}`, is_dir: false, size: Math.round(size), children: [], exists_locally: false });
const folder = (name, entries) => ({ name, path: `/${name}`, is_dir: true, size: 0, exists_locally: false, children: entries.map(([title, size]) => file(title, size, `/${name}`)) });
const remote = [
    folder('电影', [
        ['Dune.Part.Two.2024.2160p.mkv', 18.6 * GB],
        ['Interstellar.2014.IMAX.2160p.mkv', 22.3 * GB],
        ['Blade.Runner.2049.2017.2160p.mkv', 16.8 * GB],
        ['Arrival.2016.1080p.mkv', 6.2 * GB],
        ['The.Martian.2015.2160p.mkv', 13.4 * GB],
        ['Suzume.2022.1080p.mkv', 7.8 * GB],
    ]),
    folder('纪录片', [
        ['Planet.Earth.III.E01.2160p.mkv', 8.6 * GB],
        ['Planet.Earth.III.E02.2160p.mkv', 8.4 * GB],
        ['Blue.Planet.II.E01.2160p.mkv', 7.3 * GB],
        ['Cosmos.E01.1080p.mkv', 3.2 * GB],
    ]),
    folder('音乐', [
        ['坂本龙一 - async.flac', 452 * MB],
        ['Hans Zimmer - Interstellar.flac', 631 * MB],
        ['久石让 - A Symphonic Celebration.flac', 527 * MB],
        ['Ólafur Arnalds - some kind of peace.flac', 391 * MB],
    ]),
    folder('项目归档', [
        ['TelSync-源代码.zip', 3.7 * MB],
        ['视觉素材-2026-10.zip', 126 * MB],
        ['研究笔记.pdf', 12.6 * MB],
    ]),
    ...[
        ['01. 风之谷.1984.1080p.mkv', 4.7 * GB],
        ['02. 天空之城.1986.1080p.mkv', 5.2 * GB],
        ['03. 龙猫.1988.1080p.mkv', 3.9 * GB],
        ['04. 魔女宅急便.1989.1080p.mkv', 4.4 * GB],
        ['05. 红猪.1992.1080p.mkv', 4.8 * GB],
        ['06. 幽灵公主.1997.1080p.mkv', 6.1 * GB],
        ['07. 千与千寻.2001.1080p.mkv', 5.6 * GB],
        ['08. 哈尔的移动城堡.2004.1080p.mkv', 5.9 * GB],
        ['09. 崖上的波妞.2008.1080p.mkv', 4.3 * GB],
        ['10. 起风了.2013.1080p.mkv', 6.4 * GB],
        ['11. 你的名字.2016.1080p.mkv', 7.1 * GB],
        ['12. 天气之子.2019.1080p.mkv', 6.8 * GB],
        ['13. 言叶之庭.2013.1080p.mkv', 2.3 * GB],
        ['14. 秒速五厘米.2007.1080p.mkv', 2.9 * GB],
        ['15. 夏日大作战.2009.1080p.mkv', 5.3 * GB],
        ['16. 穿越时空的少女.2006.1080p.mkv', 4.1 * GB],
        ['17. 狼的孩子雨和雪.2012.1080p.mkv', 5.7 * GB],
        ['18. 紫罗兰永恒花园.2020.1080p.mkv', 8.2 * GB],
        ['19. 莉兹与青鸟.2018.1080p.mkv', 4.6 * GB],
        ['20. 声之形.2016.1080p.mkv', 7.4 * GB],
        ['21. 利兹与青鸟-原声集.flac', 412 * MB],
        ['22. Summer-Night-Session.flac', 298 * MB],
        ['23. 素材清单.xlsx', 284 * 1024],
        ['24. 文件归档说明.pdf', 2.1 * MB],
        ['25. 校对笔记.txt', 18 * 1024],
        ['z_片段 "导演剪辑" <校对>.txt', 8 * 1024],
    ].map(([name, size]) => file(name, size)),
];
let local = remote.filter((node, index) => node.is_dir ? index !== 1 : index % 3 !== 1)
    .map(node => ({ ...node, exists_locally: true, children: node.children.filter((_, i) => i % 2 === 0).map(child => ({ ...child, exists_locally: true })) }));
function markLocal(nodes) {
    const localPaths = new Set(local.flatMap(node => [node.path, ...node.children.map(child => child.path)]));
    for (const node of nodes) {
        node.exists_locally = localPaths.has(node.path);
        if (node.children.length) markLocal(node.children);
    }
}
markLocal(remote);
const tasks = [];
function findNode(nodes, target) {
    for (const node of nodes) {
        if (node.path === target) return node;
        const found = findNode(node.children, target);
        if (found) return found;
    }
}
const downloadableFiles = node => node.is_dir ? node.children.flatMap(downloadableFiles) : [node];
const config = { teldrive_url: 'https://fixture.invalid', access_token: 'fixture-only', local_path: '/fixture', max_concurrent_downloads: 2, rpc_allow_remote: false, rpc_secret: '', proxy_url: '', proxy_user: '', proxy_passwd: '' };
const trees = () => ({ remote, local, refreshed_at: new Date().toISOString(), from_cache: false });

http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/api/trees/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        response.write(': fixture\n\n');
        return;
    }
    if (!pathname.startsWith('/api/')) {
        const files = {
            '/': ['index.html', 'text/html'],
            '/app.js': ['app.js', 'application/javascript'],
            '/style.css': ['style.css', 'text/css'],
            '/assets/telsync-mark.svg': ['assets/telsync-mark.svg', 'image/svg+xml'],
            '/assets/daylight-landscape.webp': ['assets/daylight-landscape.webp', 'image/webp'],
            '/assets/daylight-portrait.webp': ['assets/daylight-portrait.webp', 'image/webp'],
        };
        const asset = files[pathname];
        if (!asset) { response.writeHead(404); return response.end(); }
        const assetPath = path.join(__dirname, '..', 'static', asset[0]);
        if (!fs.existsSync(assetPath)) { response.writeHead(404); return response.end(); }
        response.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-store' });
        return response.end(fs.readFileSync(assetPath));
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = body ? JSON.parse(body) : {};
    let data;
    switch (pathname) {
        case '/api/system/init-status': data = { aria2_installed: true, app_configured: true, aria2_arch: 'linux-arm64' }; break;
        case '/api/config': if (request.method === 'POST') Object.assign(config, input); data = config; break;
        case '/api/test-connection': data = '连接成功'; break;
        case '/api/trees': case '/api/trees/initial': case '/api/trees/refresh': case '/api/trees/local': data = trees(); break;
        case '/api/download/status': data = tasks; break;
        case '/api/download/delete':
            local = local.filter(node => node.path !== input.path).map(node => ({ ...node, children: node.children.filter(child => child.path !== input.path) }));
            markLocal(remote); data = '已删除'; break;
        case '/api/download/enqueue': {
            const node = findNode(remote, input.path);
            const files = node ? downloadableFiles(node).filter(file => !file.exists_locally && !tasks.some(task => task.remote_path === file.path)) : [];
            for (const file of files) tasks.push({ id: `fixture-${tasks.length}`, remote_path: file.path, file_name: file.name, status: 'Queued', downloaded: 0, total_size: file.size, speed: 0, retry_count: 0, max_retries: 3 });
            data = { added_count: files.length }; break;
        }
        case '/api/download/pause-all': tasks.forEach(task => task.status = 'Paused'); data = '已暂停'; break;
        case '/api/download/resume-all': tasks.forEach(task => task.status = 'Queued'); data = '已恢复'; break;
        case '/api/system/update-info': data = { current_version: '0.1.10', latest_version: '0.1.10', has_update: false, release_notes: 'UI fixture' }; break;
        default: response.writeHead(404, { 'Content-Type': 'application/json' }); return response.end(JSON.stringify({ success: false, message: 'Fixture endpoint unavailable' }));
    }
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ success: true, data }));
}).listen(15300, '127.0.0.1', () => console.log('Isolated UI fixture: http://127.0.0.1:15300'));
