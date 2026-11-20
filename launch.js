// 打包入口：启动监控服务并自动打开浏览器
// 用法：node launch.js  或  打包后的 exe 双击运行
const { exec } = require('child_process');

process.title = '阅卷监控 - 运行中（勿关此窗口）';

const PORT = Number(process.env.MONITOR_PORT || 8090);
const URL = 'http://127.0.0.1:' + PORT + '/';

// 延迟 1.5 秒再开浏览器，等端口监听就绪
setTimeout(() => {
  exec('cmd /c start "" "' + URL + '"', () => {});
}, 1500);

require('./monitor-server.js');
