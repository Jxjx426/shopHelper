# Netlify + Supabase 免费云端适配

2026-11-08 完成代码适配和隔离测试。2026-11-09 店主已建立 Supabase 项目，使用从项目控制台下载的公开 CA 证书，真实云数据库的 TLS/主机名校验及只读连接测试已通过。2026-11-09 已初始化空的私有云端资料表、版本订阅策略和私有 Storage bucket，真实连接检查通过。**尚未迁移营业资料，本轮未触发 Netlify 更新部署或公开发布**。默认仍是 `SHOP_BACKEND=local`，现有 `.env.local` 和营业数据库继续使用。Stage 5 不在范围内，字体、颜色、金额和历史单据规则保持原样。

## 先让店主测试

现在继续打开 `http://127.0.0.1:3000` 测试原流程：登录、切换日期、导入审核、配货、称重、单据和备份入口。不要把自动测试指向营业库。

开发检查命令：

```powershell
npm run typecheck
npm test
npm run test:cloud
npm run build
npm run cloud:check
npm run cloud:init
npm run cloud:migrate
```

最后三个命令默认只输出说明，不连接云端、不打开营业数据库、不部署。`test:cloud` 会在 `test-results` 中启动临时 PostgreSQL（127.0.0.1:55440，运行后关闭），使用模拟 Storage；不注册账号、不调用 Gemini。需要空闲的测试端口和系统允许的本机回环连接。

## 架构

四部手机用各自 data，通过同一个 HTTPS 网站登录；店里不需要 Wi-Fi，也不需要电脑一直开着。网站运行在 Netlify，业务数据库是 Supabase PostgreSQL，截图和 PDF 存 Supabase 私有 Storage。它需要手机能联网，不支持断网时四人继续修改并自动合并。

- 默认本地后端仍用持久 PGlite，只允许一个进程打开该目录。
- 云端 `SHOP_BACKEND=supabase` 使用 `pg` 和项目提供的 Supavisor **transaction pooler** 地址，单实例连接池上限 1；不使用临时磁盘保存营业资料。Netlify 上禁止回退到本地空数据库。
- 跨实例事务使用 PostgreSQL 事务级 advisory lock，然后复核会话、权限、版本、幂等编号。适合四人小店；不声称支持高吞吐或高可用。
- 所有业务表和账号哈希在不公开的 `shop_private` schema，浏览器不能直接查询或写入。浏览器只订阅 `public.shop_sync` 的一个版本数字；RLS 验证当前有效店铺会话。
- 不使用 Supabase Auth 注册员工；原店主和员工登录方式保留，不需要给四位员工分别注册托管平台账号。
- `FileStore`、数据库适配、Gemini provider 分开，之后可以替换服务。

## 同步和流量节省

页面打开时连接 Supabase Realtime，收到版本变化后才读当前日期订单；300ms 合并短时间通知。一次 SQL 事务只更新一次同步版本，不逐行发送截图、商品、餐馆或数量。未变化请求支持 ETag / 304。

连接正常时每 60 秒检查一次小型版本记录，连接降级时每 15 秒检查。JWT 有效 10 分钟、每 8 分钟更新；不在每次 WebSocket 心跳向网站索取 token。会话和版本合并成一次已提交的只读 SQL，事务初始化指令合并发送，减少数据库往返；写入仍保留完整事务锁和权限复核。页面隐藏、手机锁屏或断网后关闭连接和计时器，重新打开再检查。浏览器在后台的暂停时机由手机系统决定。

本机模式使用 SSE 接收数据库提交通知，同样没有每两秒全量轮询。读取和通知失败会显示连接状态；输入和原请求编号保留，写入没有无限自动重试。Gemini 仍先用规则和保存别名，复用提取结果；刷新、配货、称重、计费和 PDF 不调用 AI。

截图和备份用限定路径/大小的签名地址直接上传到私有 Storage，绕开网站函数的请求体限制；原图保持可供审核。PDF 使用短期签名链接、历史快照和缓存，不反复渲染/转发同一文件。签名读取链接约 2 分钟有效，已拿到链接的人在到期前可以打开，因此不要分享链接。签名上传链接由平台提供约 2 小时有效；不能单独即时撤销，超时后清理暂存文件。

## 什么时候需要注册账号

**本机验收通过后，再由店主注册自己的 Netlify Free 和 Supabase Free。现在不需要。** 注册、接受条款及平台登录由店主完成，不把密码或密钥粘贴进聊天。

后续准备步骤（不是本轮已执行的操作）：

1. Netlify 选择新的 credit-based **Free**，不购买 add-on、域名、团队席位、试用额度，不启用充值。使用免费 `*.netlify.app` HTTPS 地址。代码放自己的个人私有仓库即可；不上传 `.env*`、`data`、备份、测试输出或日志。
2. Supabase 建自己的 Free organization / project，按账号提供的免费地区选择靠近 Netlify 函数的地区。Free 函数默认 Ohio，美国东部数据库通常更合适；不要默认把数据库放新加坡造成每条 SQL 跨洋往返（函数改区域属 Pro/Enterprise，不能为此付费），不选择付费 IPv4、PITR、计算升级或存储升级。保存项目数据库密码。
3. 使用项目 Connect 页面提供的 transaction pooler 连接串。保留 TLS 证书校验；如项目要求额外 CA，从自己的官方项目页面下载证书，设置 `SHOP_DB_CA_FILE`，不能用 `rejectUnauthorized=false` 绕过。
4. 把下面的变量保存在本机受忽略的 `.env.local`（准备工具）及未来 Netlify 的服务器环境中。不要改成 `NEXT_PUBLIC_*`。四位员工只拿网站地址和各自店铺账号。
5. 初始化私有 schema / bucket，再用独立的空云测试项目做连接及四机测试。真实营业迁移和首次发布都需店主确认；不要让预览发布连接营业数据库。

## 服务端环境变量

| 变量                                   | 用途                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------- |
| `SHOP_BACKEND=supabase`                | 云数据库模式                                                           |
| `SHOP_CLOUD_FREE_TIER_CONFIRMED=true`  | 店主在两个平台确认 Free 后才设置；代码无法替你证明账号套餐             |
| `DATABASE_URL`                         | Supavisor transaction pooler PostgreSQL 连接串，含密码，服务器秘密     |
| `SUPABASE_URL`                         | 本项目的 `https://项目.supabase.co`                                    |
| `SUPABASE_PUBLISHABLE_KEY`             | 可公开的项目 key，只用于受 RLS 限制的版本订阅/签名上传                 |
| `SUPABASE_SERVICE_ROLE_KEY`            | 服务器 Storage 管理 key；可使用平台当前 secret key，不到浏览器         |
| `SUPABASE_JWT_SECRET`                  | 本项目仍接受的 legacy HS256 JWT secret，仅服务器签发短期版本订阅 token |
| `SUPABASE_STORAGE_BUCKET=shop-private` | 初始化工具创建的私有 bucket                                            |
| `SHOP_PUBLIC_ORIGIN`                   | 实际 HTTPS 根网址，无末尾 `/`；用于来源校验和后台任务入口              |
| `SHOP_DB_CA_FILE`                      | 可选的官方数据库 CA 文件路径                                           |
| `SHOP_AUTO_BACKUP=false`               | 测试期间保持关闭；云端验收通过后才开启每日云内快照                     |
| `GEMINI_API_KEY` / `GEMINI_MODEL`      | 原有服务器设置；模型仍为 `gemini-3.1-flash-lite`                       |
| `GEMINI_FREE_TIER_CONFIRMED`           | 沿用未关联 billing 的专用项目确认；未确认则只允许人工/规则审核         |

本适配的 Realtime 签名需要项目仍接受 legacy JWT secret；它不是 service-role key。若项目已撤销旧签名密钥，先停止配置并调整签名适配，不关闭 RLS 或改用公开业务表。`cloud:check -- --connect` 会检查实际 JWT 是否可订阅。平台密钥管理参考 [Supabase signing keys](https://supabase.com/docs/guides/auth/signing-keys)。

## 初始化、迁移和回退（以后确认后执行）

`netlify.toml` 已准备 Next.js 构建、Node 24、中文 PDF 字体和两个独立函数；没有部署脚本或自动开通付费资源。Netlify 应使用 Next.js 自动适配，不要当成静态网页目录上传。

初始化命令 **会创建远端 schema / 私有 bucket**，目前没有运行：

```powershell
npm run cloud:init -- --apply
npm run cloud:check -- --connect
```

初始化需要 `anon` / `authenticated` 平台角色，创建 `shop_private`、私有 `shop-private` bucket、版本 RLS 和 `supabase_realtime` publication 的单表订阅。不要把 `shop_private` 加入 Data API exposed schemas，不要为业务表设置公共读写策略。

真实迁移前，暂停全部手机操作，在旧应用导出一份完整 JSON；停止唯一旧服务器后，再复制整个本地数据库目录作保留账号的冷备。迁移需要指定刚导出的独立 JSON，校验源资料未在导出后变化：

```powershell
# 仅以后经店主确认，在停止旧服务器、准备好空目标和备份后执行：
npm run cloud:migrate -- --apply --source-backup C:/your-existing-backup/fresh-helper.json
```

迁移工具先获取本地单进程锁，只向**空目标**导入；保留原账号 ID、密码哈希、角色、权限、别名、原文、截图、历史价格、定稿快照及原 PDF 字节，保留提取缓存避免重复 AI。校验数据库内容指纹、全部账号哈希和文件后才提交。不会导出明文密码或临时生成含凭证的迁移文件。会话不迁移，所有人重新登录。

源数据库不会删除。目标有账号、业务目录或文件记录就停止，不能误覆盖已有云店。Storage 与 PostgreSQL 不能组成跨服务原子事务；SQL 失败会回滚，可能留下没有业务引用的内容地址文件，重试复用相同内容，后续清理超一天的孤立文件。不要把此迁移当作双向同步：迁移后本机和云端若分别录入，会形成两套资料。

发布前验证原账号可登录、四部手机操作、旧截图/PDF、全部日期/总额和备份恢复，再由店主确认首次发布。若要回退，先停止云端写入并导出云端最新业务备份，再决定恢复到旧本机；云端有新订单后不能直接启动旧副本当成最新数据。

## 文件、后台任务和备份

- 原图/处理图每份最大 5MB，服务端再次验证栅格、尺寸和实际字节数；备份 JSON 最大 128MB / 200000 行，过大须另行规划分档和迁出。
- Storage 使用内容地址，重复图片/PDF不重复存一份业务对象。一般业务文件保护线 700MiB；临时完整导出可使用预留空间至 850MiB，文件和待上传预约合计保护线 900MiB。暂存最多 150MiB、每账号最多 20 份。它们是应用保护线，不是平台账单/用量的精确测量，真实平台配额优先。
- 批量 PDF、完整导出和恢复是数据库记录的后台任务，每人最多 2 个待处理。后台最多 15 分钟；客户端等待有上限，失败后明确提示，不无限重发。恢复完成标记与恢复资料同事务提交，丢失响应后不会恢复第二次。
- 单份 PDF 保留原财务快照及原文件，并缓存当前简化版 Order List；单价/计价单位一行、只打印最终总额。格式和计算规则未改变。
- 每天马来西亚 02:00 的 Scheduled Function 只分发一个后台工作；即使自动备份关闭，也清理到期上传/临时导出。开启 `SHOP_AUTO_BACKUP=true` 后，同时保存每日压缩元数据快照，保留最近 14 份；复用原始图片/PDF，避免每天复制整批文件。恢复前安全快照保留，不自动轮换删除。
- 设置页可看最近成功、错误、文件用量和最近快照，并把云内快照导出为原格式的完整 JSON。恢复预览仍做独立验证、核对店名、明确勾选确认，变化后预览失效；密码不变、撤销全部会话。
- **云内快照依赖同一个 Supabase 项目的原文件，不是独立灾难备份。** 店主必须定期下载完整 JSON 到已有电脑/其他介质；下载含财务资料和截图，妥善保存。免费 Supabase 不提供本方案可依赖的平台自动备份。账号密码的独立灾难恢复另保留原冷备；正常业务 JSON 不含登录凭证。

## 费用和平台边界

2026-11-08 核对的官方页面（上线前再查看各自控制台实际套餐）：

| 项目                 | 免费方案及限制                                                                                      | 本项目处理                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Netlify Free         | $0/月，300 credits/月，硬上限、无自动充值；用完会暂停网站。请求、流量、计算和生产发布共同消耗额度   | 免费子域名；避免频繁生产发布和空闲整页轮询；不购买额度或开付费兜底 |
| Supabase Free        | PostgreSQL 500MB、文件 1GB、5GB egress、另 5GB cached egress；不活跃一周可能暂停                    | 数据和二进制分开，私有签名文件直传；关注控制台容量和出站流量       |
| Realtime Free        | 每月 200万消息、峰值 200 连接                                                                       | 四人只订阅一行版本，不传业务大包；隐藏页面断开                     |
| Netlify Functions    | 同步 60秒、buffered 请求/响应 6MB（binary有效约4.5MB）；后台15分钟，后台payload256KB；scheduled30秒 | 文件直传；慢任务只传小型 job ID，耗时工作进后台                    |
| Gemini Developer API | 原有专用未开 billing 项目和当前模型 free tier，实际项目额度为准                                     | 不改模型；配额耗尽保存草稿、人工审核；不调用付费备用模型           |
| 手机数据             | 仍由各自手机套餐承担                                                                                | 没有向电信商购买任何流量                                           |

Netlify Free 的函数区域不能免费自选；参考 [函数区域限制](https://docs.netlify.com/build/functions/configuration/#region)。数据库应靠近默认函数区域，手机数据只需跨区访问一次网站入口，避免每条 SQL 都跨区。

官方来源：[Netlify Free credits](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/)、[Netlify 使用额度](https://www.netlify.com/pricing/)、[Supabase Pricing](https://supabase.com/pricing)、[Realtime limits](https://supabase.com/docs/guides/realtime/pricing)、[函数限制](https://docs.netlify.com/build/functions/configuration/)、[Background Free 支持](https://docs.netlify.com/build/functions/background-functions/)。

不能保证任何用量都永久免费或永不暂停。达到应用保护线会拒绝新增文件并保留输入；平台达到额度、暂停或故障时网站可能暂不可用，不会自动升级或切到付费提供商。

## 真实数据去向与待验收项

云端模式保存订单、账号哈希、原截图和 PDF 到店主的 Supabase 项目，Netlify 处理受保护的业务请求。只有明确要求 AI 提取且确认数据说明后，原文或处理图才发送给 Gemini。Gemini 免费层允许 Google 按 unpaid-service 条款使用输入/输出改进产品、可能人工审核；不得上传敏感、个人或保密订单，可改用人工/规则审核。原图不发给 Gemini，但**会**存入私有 Supabase，不能再称为“只在本机”。

目前已验证本机生产构建、原流程、真实 PostgreSQL 四独立连接、RLS、迁移指纹及文件、后台任务幂等、恢复、SSE和闲置同步。Storage 使用测试替身，未执行 Netlify Linux 平台发布。2026-11-09 真实 Supabase PostgreSQL 证书校验和只读连接已通过；项目角色、签名上传 CORS、Realtime网络、后台函数路由和字体部署，以及四部手机各自 mobile data，仍须在独立测试项目验收；不得把本轮本机通过当作已经上线成功。

## 本轮检查结果

2026-11-08，全部在隔离测试资料上执行，无真实 Gemini 调用：

| 检查 | 结果 |
| --- | --- |
| `npm test` | 97 通过，0 失败；另 12 项云端测试在此命令默认跳过 |
| `npm run test:cloud` | 独立运行的 12 项全部通过，使用真实临时 PostgreSQL、四个连接和模拟 Storage |
| `npm run typecheck` / `npm run build` | 通过 |
| 四会话 HTTP 生产构建测试 | 登录、同项/不同项编辑、配货冲突、权限撤销、丢失响应重试、重复订单和定稿保护通过 |
| Netlify 两个独立函数 esbuild 本地打包 | 通过；不是已经在 Netlify 发布验证 |
| `npm audit --omit=dev` | 0 已知漏洞 |
| 浏览器 bundle 与构建 trace | 未发现已配置私密值；不含营业数据、环境文件和测试输出；包含中文 PDF 字体 |
| 手机布局 | 390×844、大字设置下检查登录、配货和备份入口，原字体/配色保留 |
| 测试清理 | 3001 与临时 PostgreSQL 已关闭；原 3000 店铺服务保留 |

2026-11-09 已完成真实 Supabase 数据库的证书校验和只读连接；未修改云数据库，未宣称签名上传、托管 Realtime 或 Netlify 后台执行已通过线上验收。公开证书位于 assets/supabase-ca.crt；本机服务器设置 SHOP_DB_CA_FILE 指向该文件，后续 Netlify 也需同样设置。

2026-11-09 上线准备更新：店主确认 Netlify 和 Supabase 均为 Free；已提供 Netlify 私有测试网址并手动导入生产变量。专用导入文件 .env.netlify.local 已受 Git 忽略，不可提交。云端私有表、bucket、TLS、权限隔离与 Realtime JWT 检查通过；原店完整 JSON 和冷数据库副本已保存在 data/backups/pre-cloud-2026-11-09-*，原库保留。公开 CA 证书和部署说明已在本机准备，构建通过。营业迁移、GitHub 推送及 Netlify 更新部署仍等待店主确认；不点击 Make public。
