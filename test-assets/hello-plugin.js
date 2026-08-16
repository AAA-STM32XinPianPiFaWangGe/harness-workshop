// hello-plugin — 本地「真实下载路径」验证用示例安装包
// 仅用于验证「订阅 → 真实下载 → sha256 校验 → 本地存档」链路是否生效。
window.__ModuleLoader__ && window.__ModuleLoader__.load({
  id: "hello-plugin",
  factory: (require) => {
    var module = { exports: {} };
    module.exports.apply = function () {};
    module.exports.inject = [];
    return module.exports;
  }
});
