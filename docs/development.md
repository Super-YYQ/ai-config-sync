# 开发说明

## 构建

```bash
npm install
npm run build
npm test
npm run test:coverage
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

- `npm run test:unit`：合并、密钥、Schema、锁、远程 URL 与 Driver
- `npm run test:integration`：隔离 HOME 下的 Setup、Capture、Plan、Apply、Rollback
- 集成夹具保留 Claude/Codex 两个目标，但禁止发现或调用宿主机插件安装流程
- Windows 文件系统套件单工作器执行，并对短暂占用的临时目录做有界重试
- `npm run test:coverage`：全套测试并执行全局及关键安全模块覆盖率门槛
