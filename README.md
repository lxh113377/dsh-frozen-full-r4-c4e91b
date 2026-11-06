# dsh-server-probe-r4

一次性 off-PC 探针仓：验证 server-deploy/ 24 件 BYTE-FROZEN 包在不依赖本机 PC 的
GitHub Actions ubuntu-latest runner 上能否原字节复现并跑通全部 dev selftest。

- 这是 ephemeral runner（≤6h、无持久 systemd、无 reboot 自起），**不是**常开服务器，
  **不等于**「关电脑也能正常使用」。并列证据，不冒充达标。
- 推前已复核 state.json / config.example.json / package.json 无真 token。
- 复跑命令序列见 _goal-server/OFF-PC-EVIDENCE-r4.md。
