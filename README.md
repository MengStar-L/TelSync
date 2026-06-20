<div align="center">

# TelSync

**把 TelDrive 的远程文件，安静、可靠地同步到你的本地磁盘。**

[![Release](https://img.shields.io/github/v/release/MengStar-L/TelSync?style=for-the-badge&label=Release)](https://github.com/MengStar-L/TelSync/releases)
![Rust](https://img.shields.io/badge/Rust-2021-2f3440?style=for-the-badge&logo=rust)
![OpenWrt](https://img.shields.io/badge/OpenWrt-procd-00a3ff?style=for-the-badge)
![Platforms](https://img.shields.io/badge/Platforms-Windows%20%7C%20Linux%20amd64%20%7C%20Linux%20arm64-16a085?style=for-the-badge)

TelSync 是一个轻量的 TelDrive 本地同步面板。它会对比 TelDrive 远程文件树与本地目录，按需把缺失文件加入 aria2 下载队列，并提供 OpenWrt 友好的自更新流程。

[下载最新版本](https://github.com/MengStar-L/TelSync/releases/latest) · [查看发布记录](https://github.com/MengStar-L/TelSync/releases) · [反馈问题](https://github.com/MengStar-L/TelSync/issues)

</div>

---

## 为什么用 TelSync

TelSync 适合把路由器、NAS 或小主机变成一个稳定的 TelDrive 落盘节点。它不试图做复杂的云盘客户端，而是专注于一件事：看清远程缺什么、下载缺什么、下载失败时留下可处理的状态。

| 能力 | 说明 |
| --- | --- |
| 文件对比 | 并排展示 TelDrive 远程文件与本地文件，快速判断缺失内容 |
| 下载队列 | 使用 aria2 执行下载，支持暂停、恢复、取消、重试 |
| 残片清理 | 取消或清空未完成任务时，同步清理半成品、`.aria2`、`.aria2__temp` |
| 代理设置 | 支持 aria2 `all-proxy`、代理账号与密码 |
| OpenWrt 友好 | 可通过 `procd` 守护运行，`v0.1.9+` 支持网页内自更新 |
| 单文件部署 | Release 产物为独立二进制，适合放在 `/mnt/sda/opt` 这类持久化目录 |

## 工作流

```mermaid
flowchart LR
    A["TelDrive 远程文件树"] --> C["TelSync 对比"]
    B["本地目录"] --> C
    C --> D["缺失文件"]
    D --> E["aria2 下载队列"]
    E --> F["本地文件"]
    E --> G["失败/取消残片清理"]
```

## 下载

从 [GitHub Releases](https://github.com/MengStar-L/TelSync/releases/latest) 下载与你设备匹配的文件。

| 系统 | 架构 | 文件 |
| --- | --- | --- |
| OpenWrt / Linux | arm64 / aarch64 | `telsync-linux-arm64` |
| OpenWrt / Linux | amd64 / x86_64 | `telsync-linux-amd64` |
| Windows | amd64 | `telsync-windows-amd64.exe` |

在 OpenWrt 上可用下面命令确认架构：

```sh
uname -m
```

## OpenWrt 部署

以下示例把 TelSync 放在 `/mnt/sda/opt`，服务名为 `telsync`。

### 1. 下载二进制

arm64 / aarch64:

```sh
mkdir -p /mnt/sda/opt
cd /mnt/sda/opt
wget -O telsync https://github.com/MengStar-L/TelSync/releases/latest/download/telsync-linux-arm64
chmod +x telsync
```

amd64 / x86_64:

```sh
mkdir -p /mnt/sda/opt
cd /mnt/sda/opt
wget -O telsync https://github.com/MengStar-L/TelSync/releases/latest/download/telsync-linux-amd64
chmod +x telsync
```

### 2. 创建 procd 服务

创建 `/etc/init.d/telsync`：

```sh
cat > /etc/init.d/telsync <<'EOF'
#!/bin/sh /etc/rc.common

START=99
USE_PROCD=1

PROG="/mnt/sda/opt/telsync"
WORKDIR="/mnt/sda/opt"

start_service() {
    procd_open_instance
    procd_set_param command "$PROG"
    procd_set_param chdir "$WORKDIR"
    procd_set_param user root
    procd_set_param respawn
    procd_set_param stdout 1
    procd_set_param stderr 1
    procd_close_instance
}
EOF

chmod +x /etc/init.d/telsync
/etc/init.d/telsync enable
/etc/init.d/telsync start
```

### 3. 打开面板

默认监听端口：

```text
http://路由器IP:5300
```

查看状态和日志：

```sh
/etc/init.d/telsync status
logread -e TelSync
ps w | grep -i '[t]elsync'
```

## 初次配置

进入设置页后填写：

| 配置项 | 说明 |
| --- | --- |
| TelDrive 地址 | 例如 `https://teldrive.example.com` |
| Access Token Cookie | TelDrive 登录后的 `access_token` Cookie |
| 本地同步文件夹 | 例如 `/mnt/sda/sdata/TelDrive` |
| 最大并发下载数 | 建议路由器从 `1` 或 `2` 开始 |
| 代理设置 | 如需访问 GitHub 或 TelDrive 代理，可配置 aria2 代理 |
| Aria2 RPC 设置 | 可限制 RPC 监听范围，并设置 RPC 密码 |

TelSync 会在程序同目录生成 `config.json`。建议把 TelSync 部署在持久化磁盘路径中，例如 `/mnt/sda/opt`。

## Aria2

TelSync 使用 aria2 执行下载任务。你可以在初始化向导中安装 aria2，也可以手动把 `aria2c` 放到 TelSync 同目录。

推荐目录结构：

```text
/mnt/sda/opt/
├── telsync
├── aria2c
└── config.json
```

## 自动更新

`v0.1.9+` 支持 OpenWrt / Linux 环境下的网页自更新。

自更新流程：

1. 在设置页点击“立即检查”。
2. 有新版本时点击“立即更新”。
3. TelSync 在路由器本机下载匹配架构的 Release 二进制。
4. 当前程序备份为 `telsync.bak`。
5. 新程序替换当前 `telsync`。
6. TelSync 主动退出，由 `procd` 自动重启服务。

如果你当前运行的是 `v0.1.8` 或更早版本，需要先手动升级到 `v0.1.9`，之后才可以使用网页自更新。

手动升级示例：

```sh
/etc/init.d/telsync stop
cd /mnt/sda/opt
cp ./telsync ./telsync.bak
wget -O ./telsync-new https://github.com/MengStar-L/TelSync/releases/latest/download/telsync-linux-arm64
chmod +x ./telsync-new
mv ./telsync-new ./telsync
/etc/init.d/telsync start
```

如果是 x86_64 设备，将下载地址替换为：

```sh
https://github.com/MengStar-L/TelSync/releases/latest/download/telsync-linux-amd64
```

恢复备份：

```sh
/etc/init.d/telsync stop
cd /mnt/sda/opt
cp ./telsync.bak ./telsync
chmod +x ./telsync
/etc/init.d/telsync start
```

## 从源码构建

```sh
git clone https://github.com/MengStar-L/TelSync.git
cd TelSync
cargo test
cargo build --release
```

构建产物位于：

```text
target/release/telsync
```

## 常见问题

### `/etc/init.d/telsync stop` 提示 `Command failed: Not found`

通常表示 procd 当前没有运行中的 TelSync 实例。先检查：

```sh
/etc/init.d/telsync status
ps w | grep -i '[t]elsync'
```

如果进程存在但 procd 状态异常，可以用 PID 手动停止：

```sh
PID="$(ps w | awk '/[t]elsync/ {print $1; exit}')"
kill "$PID"
```

### 更新后打不开页面

先看服务和日志：

```sh
/etc/init.d/telsync status
logread -e TelSync
```

如果新版本无法启动，用 `telsync.bak` 恢复。

### 下载失败或 GitHub 访问慢

可以在设置页配置 aria2 代理。自更新下载由 TelSync 后端发起，如果路由器访问 GitHub 不稳定，建议先在路由器上确认：

```sh
wget -S --spider https://github.com/MengStar-L/TelSync/releases/latest
```

## 安全提示

TelSync 会保存 TelDrive 地址、Access Token Cookie、aria2 RPC 密码等配置。建议只在可信内网中暴露管理页面，并为 OpenWrt、TelDrive、aria2 RPC 使用独立且足够强的密码。

---

<div align="center">

Made for quiet syncing on small boxes.

</div>
