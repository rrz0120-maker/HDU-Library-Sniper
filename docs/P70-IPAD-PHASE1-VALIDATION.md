# P7.0 iPad Native Compatibility 第一阶段验收归档

- 状态：`REAL_IPAD_NORMAL_BOOKING_PASS`（非高峰正常 1 小时空余座位验证通过；不含 20:00 高峰验证）
- 最终版本：`7.0.2-phase1`
- 独立安装文件：`userscripts/hdu-p70-ipad-phase1.user.js`
- SHA256：`44db0771cff35a4d0a5496a07beba426980e9432c0b843c049d16ec274d1f80e`（65,793 字节）
- 离线模拟测试：P7.0 核心 12/12、P6.1 核心 34/34、P5.3 核心 36/36 全部通过。
- 真机脱敏证据：`docs/evidence/p70/ipad-phase1-real-booking-20261120.json`
  - 2026-11-20 07:00—08:00（3600s）、宋韵云图（四楼）162 号，`attempts=1`、`recordVerified=true`、`SERVER_SUCCESS`、`RECORD_VERIFIED`。
- 关键 Safari/Userscripts 适配结论：
  1. 必须声明 `// @inject-into page`，否则 Safari WebExtension 内容脚本发 `POST` 会被拦截。
  2. 第 4/5 步复用第 3 步有效座位快照，整条流程仅发 1 次 `POST /Seat/Index/searchSeats`，避免业务层 HTTP 200 频繁提示。
  3. 独立 IndexedDB `hdu-p70-ipad-booking` 与 `durability: "strict"` 降级兼容在真机正常运行。
