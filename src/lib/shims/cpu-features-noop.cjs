// 构建期替身（Stage 0.5）。
// cpu-features 是 ssh2 声明的 optionalDependency（原生 CPU 特性探测，仅用于优化加密实现选择）。
// 它在 lib/index.js 里静态 require('../build/Release/cpufeatures.node')，Turbopack 无法把
// 原生 addon 放进 ESM chunk，于是「装了该包」的干净安装必然构建失败。
// ssh2 的调用点是 try { require('cpu-features')() } catch {}，因此这里返回一个总是给出
// undefined 的函数，等价于「该可选包不存在」，ssh2 会走纯 JS 回退路径（与当前生产一致）。
module.exports = () => undefined;
