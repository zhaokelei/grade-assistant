// 独立线程计时器：Web Worker 的定时器不受后台标签页节流影响
self.onmessage = function (e) {
  const { id, ms } = e.data || {};
  setTimeout(function () {
    self.postMessage({ id: id });
  }, ms);
};
