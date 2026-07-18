# 开发说明

## 构建

```bash
npm install
npm run build
npm test
```

## 包依赖

```
cli → recipe-engine → drivers → core
                 ↘ state-manager → core
                 ↘ scanner → core
cli → git-sync → core
cli → scanner
```

## 添加 Driver

1. 在 `drivers/src/index.ts` 实现 `Driver` 接口
2. 注册到 `REGISTRY`
3. 在 `DriverNameSchema`（core）增加枚举值
4. 补充 Driver 单测

## 私有配置 Schema

见 `packages/core/src/schemas.ts`（Zod 源）与 `schemas/` 导出说明。

## 测试策略

- 单元：合并、密钥、Schema、远程 URL 归一化
- Driver：临时 HOME 下幂等 copy
- 集成：模板仓库 setup → plan → apply → 双工具独立副本 → 二次 setup No changes
