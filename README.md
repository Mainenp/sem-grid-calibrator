# SEM 栅格畸变分析

这是从 `wlwang-gh/myCV` 的 `zwj` 分支整理的独立源码快照，仅包含 SEM 方格栅格分析应用。没有复制原仓库的 Git 历史、其他应用、采集图片、结果缓存或报告成品。

## 启动

安装 Node.js 22 或更新版本，在仓库根目录运行：

```sh
npm install
npm start
```

打开 http://localhost:4173，在单图入口选择 TIFF 并点击上传，再提取中心和计算畸变。批量入口支持多张 TIFF 顺序分析及 CSV/JSON 导出。

本仓库不附带示例 TIFF。请先上传自己的图像，不要直接点击“加载默认图”。也可以通过 `SEM_GRID_IMAGE` 环境变量指定自己的默认 TIFF 路径。

## 核心功能

- 原分辨率中心精定位和鲁棒行列拟合。
- 相似晶格参考、默认三次及空间留出验证后选用的五次平滑位移场与分量分析。
- 自动识别稳定重复的分区间距，保留样品自身结构。
- 仿射回正、完整畸变补偿及补偿图重新检测。
- px、扫描宽度百分比、周期百分比和带来源说明的物理单位。
- 当前页面内展开的四张参数依赖综合图。

模型、质量门槛、适用条件和已知限制见 [TECHNICAL.md](apps/distortField/TECHNICAL.md)。当前应用面向亮色方格，不包含暗圆孔的试验程序。

## 数据与测试

参数图表读取本地生成的 `apps/distortField/public/parameter-analysis-data.json`；该文件刻意不上传。没有批次数据时图表暂不可用，但单图和批量分析可以正常使用。辅助生成脚本及其所需缓存见应用 README。

```sh
npm test
npm run test:accuracy --workspace=distort-field
```

上述测试不需要采集图片，覆盖分区参考、补偿恒等映射、单位换算、画布重绘、TIFF 兼容和解析真值。图像回归测试 `test-grid.js` 和 `test-compensation-api.js` 需要提供自己的默认样例，不能在无数据仓库中直接当作基线验收。

完整合成场景验证：

```sh
npm run accuracy:validate --workspace=distort-field
```

合成真值测试用于量化已覆盖条件下的算法误差；单图自拟合和补偿重检不构成独立的绝对物理精度或 10 nm 验收证明。

## 共享

仓库目前公开，可通过链接查看或克隆。仓库只发布源码、测试和技术说明，不包含实采图片、分析缓存或报告成品。

## 来源

基础项目来自 `wlwang-gh/myCV`，初始快照源提交为 `66d1fe293880a8112e647c9a8492456c9d56c500`。保留原项目 LICENSE 及已有源码中的许可、署名信息。
