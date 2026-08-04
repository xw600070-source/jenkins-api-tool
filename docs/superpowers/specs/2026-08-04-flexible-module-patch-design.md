# 灵活模块打包(patch 命令参数化)

> 日期:2026-08-04
> 状态:设计中

## 1. 背景与问题

`examples/02-build-pcx-full-workflow.ts`(即 `npm run pcx`)当前打包流程:

1. 触发 `orange-aliyun` 全量构建(按 `version_file` 版本清单打包所有模块)→ 全量包 `orange_YYYYMMDDHHmmss.zip`
2. 触发 `orange-patch` 构建,`orange_module` 写死 `"pcx"` → 从全量包抽取 pcx 模块,产出 `update_patch_pcx_*.zip`
3. 下载补丁包到 `downloads/`

**痛点(两处写死)**:

- `version_file` 的文件名写死为 `examples/vOrange-gwzc-530`(第 20 行)
- `orange_module` 写死为 `"pcx"`

导致无法切换版本清单,也无法切换/组合模块。

## 2. 目标

把这两处写死都参数化:

- `--project`:指定用哪个 vOrange 版本清单
- `--module`:指定保留哪些模块(单/多)
- 复用现有 `orange-aliyun` + `orange-patch` job,改动最小

## 3. 方案选择

评估了三个方案:

- **A 本地裁剪**:下载全量包 → 本地解压保留模块 → 重打包。最灵活,但需新增"下载全量包"步骤,改动较重。
- **B 服务器参数化**:把 `orange_module` / `version_file` 参数化,复用现有 job。改动最小。
- **C 配置文件化**:统一配置 build_type/options/modules。最彻底,但改动大,超出当前需求。

**选定 B**:精准命中痛点,改动最小,复用成熟 job。

## 4. 关键事实(已查证)

通过 Jenkins API 查询 `orange-patch` job 的参数定义和 `config.xml`:

| 事实 | 依据 |
|------|------|
| `orange_module` 是 `PT_CHECKBOX`(多选复选框) | `config.xml` choiceType |
| 选项由 `readOrangeModule <全量包>` 动态生成,级联依赖 `orange_package` | `config.xml` groovy script |
| 多选值以逗号拼接送入 shell:`none,${orange_module}` | `config.xml` 构建命令 |
| **多模块出一个合并包**(不是多个) | 用户确认(Jenkins 实际行为) |
| `version_file` 由本地整体上传,Jenkins 端解析 | `build-service.ts` prepareFormData:`fs.createReadStream` + multipart |

结论:**多模块不需要循环调用**,一次 `orange-patch` 构建传 `pcx,home` 即出一个含两模块的合并包。

## 5. 设计

### 5.1 目录与命令

新建 `project/` 目录集中存放 vOrange 版本清单文件,把现有 `examples/vOrange-gwzc-530` 迁移过去。

```bash
npm run patch -- --project vOrange-gwzc-530                    # 必传:用哪个版本清单
npm run patch -- --project vOrange-gwzc-530 --module pcx       # + 指定模块(默认 pcx,可省略)
npm run patch -- --project vOrange-gwzc-530 --module pcx,home  # + 多模块(出一个合并包)
npm run patch -- --project vOrange-xxx --module public         # 另一份清单 + 换模块
```

| 参数 | 必填 | 默认 | 作用 |
|------|------|------|------|
| `--project` | 是 | 无 | `project/` 下的 vOrange 文件名 → `version_file` |
| `--module` | 否 | `pcx` | 保留的模块,逗号分隔多个 → `orange_module` |

### 5.2 改动范围

**只动 `examples/02-build-pcx-full-workflow.ts` 和 `package.json`,SDK 核心不动。**

1. **新增 argv 解析**:读 `--project`(必传,缺失则报错退出)和 `--module`(默认 `pcx`)。手写解析 `process.argv`,不引入 CLI 框架。
2. **version_file 路径参数化**:
   ```typescript
   const configFilePath = path.join(process.cwd(), "project", projectName);
   ```
3. **orange_module 参数化**:`orange_module: "pcx"` → `orange_module: moduleArg`。
4. **下载/日志解析不动**:多模块也是一个合并包,现有正则匹配 `.zip` URL 照常命中。
5. **package.json**:`"pcx": ...` → `"patch": ...`。
6. **文件迁移**:`examples/vOrange-gwzc-530` → `project/vOrange-gwzc-530`。

### 5.3 多模块机制

- `orange_module` 是 `PT_CHECKBOX` 多选,传逗号分隔值(如 `pcx,home`)
- 一次 `orange-patch` 构建出一个合并包
- 不循环调用

## 6. 不做(YAGNI)

- ❌ 不改 `build_type` / `options`(属方案 C,超出范围)
- ❌ 不改 `version_file` 的读取方式(仍 `fs.createReadStream` 整体上传,Jenkins 端解析)
- ❌ 不引入新依赖(不用 commander/minimist 等 CLI 框架)
- ❌ 不改 SDK 核心(`JenkinsClient` 等)
- ❌ 不改 `orange-aliyun` 全量打包步骤本身

## 7. 验证结果(已通过 ✅)

多模块逗号格式 `pcx,home` 已通过真实构建验证(2026-08-04):

- `orange-patch` 产出一个合并包 `update_patch_orange_*.zip`,同时含 `modules/pcx/` 和 `modules/home/`(共 523 文件)
- 逗号格式被 Jenkins 正确拆分为两个模块,假设成立

**附注(产物命名)**:多模块时产物包名为 `update_patch_orange_*.zip`(用产品名 "orange");单模块时为 `update_patch_<模块>_*.zip`(如 `update_patch_pcx_*.zip`)。这是 Jenkins 端 `orange-patch.sh` 的命名行为,不影响下载(脚本正则匹配任意 `.zip` URL)。

## 8. 向后兼容

- 命令名 `pcx` → `patch`
- `--project` **必传**:旧的 `npm run pcx`(无参)不再可用,需显式传 `--project`。这是有意的——强制指定版本清单,避免误用。
- `--module` 默认 `pcx`(单模块时行为同改造前)
- 如需保留旧 `pcx` 命令名,可在 `package.json` 加 alias(可选,默认不保留)
