# CircuitLab 电路工作站

CircuitLab 是面向本科电路课程的本地浏览器工具。可以从图片、中文描述、网表或手工绘图建立同一份电路模型，再在画布旁核对连接、求解和查看化简推导。

## 快速开始

在项目目录中使用 Node.js 20 或更新版本。项目无需安装 npm 依赖。

```sh
node server.mjs
```

在浏览器打开本地工作站。端口被占用时，可用 `node server.mjs 9132` 改用其他端口。[本地工作站](http://127.0.0.1:9128)

若要生成单文件离线版，运行 `node build.mjs` 后双击 `dist/CircuitLab.html`。生成的文件内嵌脚本、样式和图标。工程自动保存在当前浏览器的本地存储中，也可下载 JSON 用于备份和迁移。

首次使用可从内置示例打开一个电路，点击「运行分析」，再双击画布上的元件修改数值并重算。

## 使用

- **图片识别**　拖入、粘贴或选择 PNG、JPEG、WebP。支持斜向圆形电压源和矩形阻抗，读取电压相量、复阻抗和图中的源方向。原图面板标记元件与交叉点，可切换交叉点是否连接。核对数值、极性和连线后即可运行分析。
- **文字与网表**　可输入「5 V 电压源、1 kΩ 电阻与 100 nF 电容串联，构成低通电路。」混合拓扑可逐支路描述，如「R1 1 kΩ 接在 in 与 out 之间」，也可粘贴下方网表。
- **画布编辑**　点击或拖入元件，点击两个端口建立连接。双击元件可编辑数值，用 Enter 提交。右键或属性面板可旋转、镜像、改变参考方向、对调端口和断开连接。拖动空白区框选，按住 Space 平移，滚轮缩放，按 0 适应画布。
- **分析与化简**　运行分析后切换右侧方法。支持专用拓扑识别（惠斯通电桥及平衡判定、Δ/Π、Y/T 及三相 Δ–Y / Y–Δ / Y–Y / Δ–Δ）与对应自动排版。化简严格按单步局部等效变换执行，覆盖串并联（R/Z/L/C）、双向 Δ–Y / Y–Δ、平衡电桥去桥臂、电源互换与开短路。每步保留变换依据、公式与代入计算结果、视觉连续性指标、独立求解器双重验证（全电路 MNA + 多端口导纳/阻抗矩阵）以及高亮变化区域的前后电路图；自动化简内置有界前瞻路径规划与规范指纹循环检测，避免无意义反复变换。
- **LLM / CLI / MCP 工具接口**　提供统一的确定性工具集（`src/tooling.js`），使 LLM 可直接读取、编辑、验证、识别拓扑、逐步化简、等价性校验和渲染电路：
  - **CLI 命令行**：`node tools/circuitlab-cli.mjs tools` 查看全部 JSON Schema；`node tools/circuitlab-cli.mjs reduce-auto --example bridge --out-dir ./steps --format markdown` 逐步化简并导出每一步的高亮 SVG 与 Markdown 推导报告。
  - **MCP Stdio 服务**：`node tools/circuitlab-cli.mjs mcp` 启动零依赖 JSON-RPC 2.0 MCP 服务，直接供支持 MCP 的 LLM 客户端调用。
  - **本地 HTTP 工具 API**：启动 `node server.mjs` 后可通过 `GET /api/tools` 与 `POST /api/tools/<toolName>` 调用全部工具（仅绑定 `127.0.0.1`）。
- **保存与导出**　工程 JSON 保留几何、参数、识别记录和化简历史。SVG 保留可编辑的当前电路模型并支持变化区域高亮样式，回导时读取模型。PNG 用于插图。HTML 计算报告包含电路图、结果与原始数值数据。

```text
V1 in 0 DC 5 AC 1
R1 in out 1k
C1 out 0 100n IC=0
.end
```

网表支持 R/L/C、V/I、E/G/F/H、理想运放 U、理想变压器 T、互感 K、三相源 V3_、开路 O、短路 S、固定复阻抗 Z 和简单 `.param` 引用。`Z1 a 0 5√3 5` 表示从节点 a 到参考节点的 `5√3 + j5 Ω`。工程单位区分 `m` 与 `M`，`meg` 也表示兆。源的 AC 参数采用有效值和角度。网表扩展与格式见 [src/input.js](src/input.js)。

可在「本地视觉设置」中连接 OpenAI 兼容的视觉服务。地址需为本机回环且服务允许浏览器访问。提交时将图片发送给指定的本机服务，密钥不写入工程或自动保存。基本识别不需要该服务，导入的图片不会自动发往网络。

## 教材覆盖

以高等教育出版社邱关源原著、罗先觉主编《电路》第六版的章节为范围参考。[教材目录](https://www.hep.com.cn/book/show/6cc344e5-c06f-4801-8ad5-ebf5b66c45ac)

| 主题 | 当前可运行的分析或变换 |
| --- | --- |
| 电路定律与电阻网络 | 修正节点法、支路电流法、基于生成树的回路电流法、KCL/KVL 残差、开路短路、串并联、星形和三角形互换 |
| 网络定理与受控线性电路 | 叠加、戴维南与诺顿、独立源等效和串并组合、直流与正弦交流最大功率传输、四类受控源和理想运放 |
| 储能元件与暂态 | 初值、零输入/零状态/全响应、阶跃、单位冲激、矩形脉冲卷积、同类零初始 R/L/C 化简 |
| 正弦稳态与三相 | 幅值与相角、相量图、复功率与功率因数、互感、理想变压器、星形三相源及平衡或不平衡负载、频率响应 |
| 网络函数与图论 | 数值扫频、低阶网络函数及极零点、方波和三角波的有限项傅里叶稳态叠加、关联/回路/割集矩阵、二端口 Z/Y/h/ABCD |

## 验证

`node --test` 有 43 项自动测试，覆盖图结构、模型往返、单位、电路解析解、布线、专用拓扑识别与布局（电桥、Δ/Y、三相 Δ–Y / Y–Δ）、逐步等效化简与视觉连续性、路径规划与循环检测、独立求解器等价性验证、变化区域高亮 SVG、LLM/CLI/MCP/HTTP 工具接口、像素识别、斜向符号、复数标注和三相源闭环。

用 `node server.mjs 9133 --qa` 启动浏览器验收。全新检出可测试三张 OpenStax 图和三张 Fiore 重绘题。独立 RC 图和用户原图为本地附加样本，验收页会标记缺少的文件。使用 `?bundle` 可让三相验收加载已构建的单文件版。[本地验收页](http://127.0.0.1:9133/test/browser.html)

| 浏览器真实图片 | 正确识别元件 | 数值 | 整图拓扑 |
| --- | --- | --- | --- |
| OpenStax 图 21.3 左侧，三个串联电阻 | 4/4 | 未印出 | 通过 |
| OpenStax 图 21.21，双回路 | 7/7 | 未印出 | 通过 |
| OpenStax 图 21.37(a)，RC 与闭合开关 | 4/4 | 未印出 | 通过 |
| 独立发布的带负载 RC 图，裁剪到电路区域 | 5/5 | 3/3 | 通过 |

电压源和地符号计入元件统计。整图拓扑用人工核对的端口图做等价判断，数值单独计分。OpenStax 样本为原图裁剪或缩放，归 OpenStax（Rice University）所有，样本遵循原书的 [CC BY-NC-SA 4.0 许可](https://github.com/openstax/osbooks-college-physics-bundle/blob/main/LICENSE)。独立 RC 图来自公开的 ngspice 验证，额外样本只在当前本地验收目录中使用。[OpenStax 串并联](https://openstax.org/books/college-physics-2e/pages/21-1-resistors-in-series-and-parallel) · [OpenStax 基尔霍夫定律](https://openstax.org/books/college-physics-2e/pages/21-3-kirchhoffs-rules) · [OpenStax RC](https://openstax.org/books/college-physics-2e/pages/21-6-dc-circuits-containing-resistors-and-capacitors) · [独立 RC 图](https://github.com/Witali/power-amp/blob/main/results/002_ngspice_rc_lowpass/schematic/rc_lowpass.png)

Windows Edge 实际检查了中文生成、画布双击修改与重算、手工连接、真实图片拖放与校对、两步等效化简、工程回读以及 SVG、PNG、HTML 输出。典型分压题的「文字生成 → 生成电路 → 运行分析」需要三次按钮操作和一次文本输入，始终留在一个工作区。手工搭建含参考地的电阻回路需要新建、三次添加、六次端口操作和一次分析。

三相 Δ–Y 原图和三张根据教材重绘的 Y–Y、Δ–Y、Y–Δ 图均通过图片导入、拓扑与参数匹配及交流稳态验收。四张图的 12 条线电流均与人工解吻合。[压力测试记录](test/delta-y-stress.md)

## 能力边界

- 本地识别面向清晰的印刷图。斜向检测覆盖圆形电压源与电阻或阻抗轮廓。数学标注以邻近的印刷等式为主，缺失数据或源方向需要人工确认。手写、拍照透视、复杂符号和重叠文字仍需人工校对。
- 当前分析核心是线性、集中参数模型。极零点、有理函数、冲激和矩形脉冲卷积限于至多两个储能元件。一般电路的符号参数求解、自动网孔识别、非线性器件、任意时变换路、详细小信号模型和分布参数传输线尚未覆盖。窗口中的分析方法会提示适用范围。
- 跨平台代码使用标准 Node.js 和浏览器 API。本轮浏览器验证在 Windows Edge 完成，Linux 原生运行和真实本机视觉服务尚未实测。

## 工程结构

浏览器原生 ES 模块实现界面和计算。Circuit IR 与几何布局分别存储，布线以端口为起点，布局过程同时校验图同构和渲染路径连通性。`src/model.js` 定义模型，`src/topology.js` 识别电桥、Δ/Y 与三相拓扑并生成规范结构指纹，`src/layout.js` 与 `src/drawing.js` 负责专用排版、视觉连续性保位与高亮 SVG 渲染，`src/analysis.js`、`src/verify.js` 与 `src/reduce.js` 负责求解、独立等价性验证与逐步化简路径规划，`src/tooling.js` 提供确定性 LLM 工具接口，`src/recognize.js` 识别图片。Node.js 服务同时提供本地静态资源与 `/api/tools` 本地工具接口。

- `test/` 保存自动测试、浏览器验收页、可分发的样本及参考解。
- `tools/circuitlab-cli.mjs` 提供跨平台（Linux/macOS/Windows）CLI 与 MCP stdio 服务；`tools/make-three-phase-fixtures.mjs` 可重新生成三张三相测试图。
- `dist/` 保存本地构建产物。
