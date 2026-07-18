# JSON Schema 导出说明

运行时以 Zod 为准（`packages/core/src/schemas.ts`）。

主要文件形态：

| 文件 | Schema |
|------|--------|
| 私有仓库 `config.yaml` | `ConfigRepoSchema` |
| 私有仓库 `resources.yaml` | `ResourcesFileSchema` |
| 私有仓库 `recipes/*.yaml` | `RecipeSchema` |
| 私有仓库 `profiles/*.yaml` | `ProfileSchema` |
| 私有仓库 `lock.yaml` | `LockFileSchema` |
| 本机 `~/.ai-config-sync/config.yaml` | `LocalConfigSchema` |
| 本机 `state.json` | `StateFileSchema` |
| 本机 `pending-events.json` | `{ batches: PendingBatch[] }` |
| AI 候选输出 | `CandidateRecipeSchema` |

需要 JSON Schema 文件时，可使用 `zod-to-json-schema` 从上述 Zod 对象生成（M2 可加脚本）。
