const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');

const port = 7359;
const httpsPort = 8443;
const ipAddress = getLocalIpAddress();
const hashAlgorithm = "sha512";
const securityFile = "security.ini";
const securityFileHash = "security.ini.hash";
const logFile = 'access.log';
const maxLoginAttempts = 5;
const MAX_LOAD_CHANGES = 100;
let loginAttempts = 0;
let initialSetupFlag = !fs.existsSync(securityFile);

// 로그 파일 기록
function logEvent(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(logFile, logMessage);
}

// 솔트 생성
function generateSalt(length = 16) {
    return crypto.randomBytes(length).toString('hex');
}

// 해시 생성
function generateHash(data) {
    return crypto.createHash(hashAlgorithm).update(data).digest('hex');
}

// 파일 해시 생성
function generateFileHash(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    return generateHash(content);
}

// 인증서 찾기
let httpsOptions;
try {
    const keyPath = path.join(__dirname, 'privkey.pem');
    const certPath = path.join(__dirname, 'cert.pem');
    httpsOptions = {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath)
    };
} catch (err) {
    console.log('Could not find HTTPS certificates. Running server in HTTP mode.');
    console.log('\n');
    httpsOptions = null;
}

// 비밀번호 설정
if (!initialSetupFlag) {
    const storedFileHash = fs.readFileSync(securityFileHash, 'utf8');
    const currentFileHash = generateFileHash(securityFile);
    if (storedFileHash !== currentFileHash) {
        console.error("Security file has been tampered with!");
        process.exit(1);
    }
}

// 호스트 이름 습득
function getHostname() {
    return os.hostname();
}

// 업타임 습득
function formatUptime(seconds) {
    const days = Math.floor(seconds / (3600 * 24));
    const hours = Math.floor((seconds % (3600 * 24)) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) {
        return `${days}d ${hours}h ${minutes}m`;
    }
    return `${hours}h ${minutes}m`;
}

// CPU 로드율 계산
function calculateCpuLoad() {
    const cpus = os.cpus();
    const load = cpus.map(cpu => {
        let totalTick = 0, totalIdle = 0, totalUser = 0, totalSys = 0;
        for (const type in cpu.times) {
            totalTick += cpu.times[type];
            if (type === 'idle') totalIdle += cpu.times[type];
            if (type === 'user') totalUser += cpu.times[type];
            if (type === 'sys') totalSys += cpu.times[type];
        }
        return { idle: totalIdle, total: totalTick, user: totalUser, sys: totalSys };
    });
    return load;
}

// 네트워크 트래픽 계산
let previousNetworkStats = os.networkInterfaces();
function calculateNetworkTraffic() {
    const currentStats = os.networkInterfaces();
    let totalSent = 0, totalReceived = 0;

    for (const iface in currentStats) {
        if (previousNetworkStats[iface]) {
            currentStats[iface].forEach((current, index) => {
                const previous = previousNetworkStats[iface][index];
                if (previous) {
                    const sent = current.tx_bytes - previous.tx_bytes;
                    const received = current.rx_bytes - previous.rx_bytes;
                    totalSent += sent;
                    totalReceived += received;
                }
            });
        }
    }

    previousNetworkStats = currentStats;
    return { sent: totalSent, received: totalReceived };
}

// 디스크 I/O 계산
function calculateDiskUsage() {
    const diskUsage = fs.statSync('/');
    return {
        total: diskUsage.blksize * diskUsage.blocks,
        free: diskUsage.blksize * diskUsage.bfree,
        used: diskUsage.blksize * (diskUsage.blocks - diskUsage.bfree)
    };
}

// CPU 로드율 습득
function getCpuLoad() {
    return new Promise((resolve) => {
        const start = calculateCpuLoad();
        const startTime = process.hrtime();
        let highestCpuLoad = 0;
        const loadChanges = [];
        let intervalTime = 100;
        let previousCpuLoad = 0;
        const minInterval = 50;
        const maxInterval = 200;

        const interval = setInterval(() => {
            const end = calculateCpuLoad();
            const endTime = process.hrtime(startTime);
            const elapsedTime = endTime[0] + endTime[1] / 1e9;

            let totalIdleDifference = 0, totalTotalDifference = 0;
            let totalUserDifference = 0, totalSysDifference = 0;
            let highestCoreLoad = 0;

            for (let i = 0; i < start.length; i++) {
                const idleDifference = end[i].idle - start[i].idle;
                const totalDifference = end[i].total - start[i].total;
                const userDifference = end[i].user - start[i].user;
                const sysDifference = end[i].sys - start[i].sys;
                const coreLoad = 100 - (idleDifference / totalDifference * 100);
                highestCoreLoad = Math.max(highestCoreLoad, coreLoad);
                totalIdleDifference += idleDifference;
                totalTotalDifference += totalDifference;
                totalUserDifference += userDifference;
                totalSysDifference += sysDifference;
            }

            const percentageCpu = highestCoreLoad;
            highestCpuLoad = Math.max(highestCpuLoad, percentageCpu);
            loadChanges.push(percentageCpu);

            // 배열 크기 제한
            if (loadChanges.length > MAX_LOAD_CHANGES) {
                loadChanges.shift();
            }

            // 메모리 사용량 계산 (스왑 영역 포함)
            const totalMem = os.totalmem();
            const freeMem = os.freemem();
            const usedMemPercentage = ((totalMem - freeMem) / totalMem) * 100;

            // 네트워크 트래픽 계산
            const networkTraffic = calculateNetworkTraffic();
            const networkLoad = (networkTraffic.sent + networkTraffic.received) / (1024 * 1024);

            // 디스크 I/O 계산
            const diskUsage = calculateDiskUsage();
            const diskUsagePercentage = (diskUsage.used / diskUsage.total) * 100;

            // 동적 측정 주기 조절 (지수적 조절 및 변화량 기반)
            const cpuLoadChange = Math.abs(percentageCpu - previousCpuLoad);
            previousCpuLoad = percentageCpu;

            if (percentageCpu > 80 || usedMemPercentage > 80 || networkLoad > 10 || diskUsagePercentage > 80 || cpuLoadChange > 10) {
                intervalTime = Math.max(minInterval, intervalTime / 2); // 부하가 높거나 변화량이 클 때 주기 감소
            } else if (percentageCpu < 20 && usedMemPercentage < 20 && networkLoad < 1 && diskUsagePercentage < 20 && cpuLoadChange < 5) {
                intervalTime = Math.min(maxInterval, intervalTime * 1.5); // 부하가 낮고 변화량이 작을 때 주기 증가
            }

            if (elapsedTime >= 1) {
                clearInterval(interval);
                resolve({
                    highestCpuLoad: highestCpuLoad.toFixed(2),
                    averageCpuLoad: (loadChanges.reduce((acc, cur) => acc + cur, 0) / loadChanges.length).toFixed(2),
                    loadChanges: loadChanges,
                    diskUsage: diskUsagePercentage.toFixed(2),
                    userCpuLoad: (totalUserDifference / totalTotalDifference * 100).toFixed(2),
                    sysCpuLoad: (totalSysDifference / totalTotalDifference * 100).toFixed(2)
                });
            }
        }, intervalTime);

        setTimeout(() => {
            if (interval) {
                clearInterval(interval);
                resolve({
                    highestCpuLoad: highestCpuLoad.toFixed(2),
                    averageCpuLoad: (loadChanges.reduce((acc, cur) => acc + cur, 0) / loadChanges.length).toFixed(2),
                    loadChanges: loadChanges,
                    diskUsage: "N/A",
                    userCpuLoad: "N/A",
                    sysCpuLoad: "N/A"
                });
            }
        }, 1000); // 1초 후 강제 종료
    });
}

// 시스템 정보 습득
async function getSystemInfo() {
    const cpuModel = os.cpus()[0].model;
    const hostname = getHostname();
    const uptime = formatUptime(os.uptime());

    let cpuLoad;
    try {
        cpuLoad = await getCpuLoad();
    } catch (error) {
        logWithTimestamp('Error retrieving CPU load: ' + error.message);
        cpuLoad = { highestCpuLoad: 'N/A' }; // 기본값 할당
    }

    const totalMem = os.totalmem() / (1024 * 1024 * 1024);
    const freeMem = os.freemem() / (1024 * 1024 * 1024);
    const usedMem = totalMem - freeMem;

    const systemInfo = {
        cpuModel: cpuModel,
        hostname: hostname,
        uptime: uptime,
        cpuUsage: cpuLoad.highestCpuLoad + ' %',
        totalMem: totalMem.toFixed(2) + ' GiB',
        usedMem: usedMem.toFixed(2) + ' GiB'
    };

    const logMessage = `System Info: \nCPU Model : ${systemInfo.cpuModel}\nHostname : ${systemInfo.hostname}\nUptime : ${systemInfo.uptime}\nCPU Usage : ${systemInfo.cpuUsage}\nTotal Memory : ${systemInfo.totalMem}\nUsed Memory : ${systemInfo.usedMem}`;
    console.clear();
    console.log(logMessage);

    return JSON.stringify(systemInfo);
}

process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', () => {
    console.log('Key press detected, continuing...');
});

// 서버 종료
function shutdownServer() {
    console.log("Server is shutting down...");
    server.close(() => {
        process.exit(0);
    });
}

// 서버 설정
const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/') {
        fs.readFile('client.html', (err, data) => {
            if (err) {
                res.writeHead(500);
                return res.end('Error loading client');
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else if (req.method === 'GET' && req.url === '/initial-setup') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ initialSetupComplete: !initialSetupFlag }));
    } else if (req.method === 'POST' && req.url === '/setup-password' && initialSetupFlag) {
        let body = '';

        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', () => {
            const { newPassword } = JSON.parse(body);
            const salt = generateSalt();
            const hash = generateHash(newPassword + salt);
            const securityData = JSON.stringify({ hash, salt });
            fs.writeFileSync(securityFile, securityData);
            fs.writeFileSync(securityFileHash, generateFileHash(securityFile));
            initialSetupFlag = false;
            logEvent('Initial password setup completed.');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        });
    } else if (req.method === 'POST' && req.url === '/login') {
        if (initialSetupFlag) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, message: 'Password needs to be set first.' }));
        }

        let body = '';

        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', () => {
            if (loginAttempts >= maxLoginAttempts) {
                logEvent('Too many login attempts.');
                res.writeHead(429, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: false, message: 'Too many login attempts. Please try again later.' }));
            }

            const { password } = JSON.parse(body);
            if (validatePassword(password)) {
                logEvent('Successful login.');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
                loginAttempts = 0;
            } else {
                loginAttempts++;
                logEvent('Failed login attempt.');
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Invalid password' }));
            }
        });
    } else if (req.method === 'POST' && req.url === '/shutdown') {
        if (initialSetupFlag) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, message: 'Password needs to be set first.' }));
        }

        let body = '';

        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', () => {
            if (loginAttempts >= maxLoginAttempts) {
                res.writeHead(429, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: false, message: 'Too many shutdown attempts. Please try again later.' }));
            }

            const { password } = JSON.parse(body);
            if (validatePassword(password)) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
                shutdownServer();
            } else {
                loginAttempts++;
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Invalid password' }));
            }
        });
    } else if (req.method === 'GET' && req.url === '/sysinfo') {
        const systemInfo = await getSystemInfo();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(systemInfo);
    } else {
        res.writeHead(404);
        res.end();
    }
});

// 로컬 IP 주소를 얻는 함수
function getLocalIpAddress() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            const { address, family, internal } = iface;
            if (family === 'IPv4' && !internal) {
                return address;
            }
        }
    }
    return '127.0.0.1'; // 기본값
}

/*
// 로컬 전용 포트
server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}/`);
});
*/

// HTTP 리스너
server.listen(port, '0.0.0.0', () => {
    console.log(`Server running at ${ipAddress}`);
    console.log(`Port: ${port}`);
    console.log('\n');
    console.log('Please log in at webpage...');
    console.log('\n');
    console.log(`Press CTRL + C to shutdown server`);
});

// HTTPS 리스너
if (httpsOptions) {
    const httpsServer = https.createServer(httpsOptions, server);
    httpsServer.listen(httpsPort, '0.0.0.0', () => {
        console.log(`HTTPS Server running at ${ipAddress}:${httpsPort}`);
        console.log(`Port: ${httpsPort}`);
        console.log('\n');
        console.log('Please log in at webpage...');
        console.log('\n');
        console.log(`Press CTRL + C to shutdown server`);
    });
}

// 비밀번호 검증
function validatePassword(inputPassword) {
    const securityData = JSON.parse(fs.readFileSync(securityFile, 'utf8'));
    const inputHash = generateHash(inputPassword + securityData.salt);
    return securityData.hash === inputHash;
}
