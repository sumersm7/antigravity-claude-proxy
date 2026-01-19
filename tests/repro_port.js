const http = require('http');

function testPort(port) {
    return new Promise((resolve) => {
        const server = http.createServer();
        server.on('error', (err) => {
            console.log(`Port ${port}: FAILED - ${err.code} (${err.message})`);
            resolve(false);
        });
        server.listen(port, () => {
            console.log(`Port ${port}: SUCCESS - Bound successfully`);
            server.close(() => resolve(true));
        });
    });
}

async function run() {
    console.log('Testing ports...');
    await testPort(51121);
    await testPort(51122);
    await testPort(0); // Test dynamic port
}

run();
