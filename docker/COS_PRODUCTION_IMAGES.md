# Daytona Local-First V1 生产镜像交付

本文档说明如何从固定 local-first V1 源提交构建、核验和分包导出 Daytona v0.190.0 的四个 `linux/amd64` 产品镜像。该源码同时保留旧 COS sandbox 兼容性。交付脚本默认只在本地加载镜像，不登录 registry，也不执行 push。

> **禁止直接部署 base Runner：** `daytona-runner-base` 包含 local volume backend，但没有旧 COS sandbox 所需的 `s3fs-fuse` 和 `mount-s3 --prefix` wrapper。最终候选 Runner 必须由 Suna 的 `infra/daytona/runner/Dockerfile` 基于本镜像添加这些组件，才能同时支持 local-first 与旧 COS sandbox。

## 固定身份

本交付只接受以下不可变身份：

```text
源提交：2862ea8776372cd5e9e380a6145d2b08ec6128d4
版本：  v0.190.0-local-first-2862ea87
平台：  linux/amd64
源码：  https://github.com/ruiinsurance/daytona
```

四个产品 target 和预期产物为：

| 组件 | Dockerfile | Target | 容器内产物 |
| --- | --- | --- | --- |
| API | `apps/api/Dockerfile` | `daytona` | `/daytona/dist/apps/api/main.js` |
| base Runner | `apps/runner/Dockerfile` | `runner` | `/usr/local/bin/daytona-runner` |
| Proxy | `apps/proxy/Dockerfile` | `proxy` | `/usr/local/bin/daytona-proxy` |
| SSH Gateway | `apps/ssh-gateway/Dockerfile` | `ssh-gateway` | `/usr/local/bin/daytona-ssh-gateway` |

Runner Dockerfile 还依赖 `dist/libs/computer-use-amd64`。脚本会先复用仓库的 `hack/computer-use/Dockerfile` 构建固定平台 helper，再通过 `docker create` 和 `docker cp` 提取 ELF 文件；这个 helper 不是产品交付镜像。

## 前置条件

- Docker daemon 可用。
- Docker Buildx builder 声明支持 `linux/amd64`。
- Git worktree 包含固定 V1 源提交，并且产品源码相对该提交没有未声明修改。
- 有足够空间同时容纳 BuildKit 缓存、本地镜像和四个独立 tar。
- 输出目录是 worktree 外部的绝对路径，并且在 export 前不存在；脚本会解析已有父目录的物理路径，拒绝通过符号链接绕回 worktree。

脚本不会为腾空间删除用户已有镜像、容器、builder、volume、cache 或目录。空间不足时应由操作者先盘点，再单独决定清理范围。

## 查看计划

默认本地 repository prefix 是 `daytona-local`。建议显式指定稳定的外部输出目录：

```bash
./scripts/cos-production-images.sh plan \
  --repository-prefix daytona-local \
  --output-dir /private/tmp/daytona-product-images/v0.190.0-local-first-2862ea87
```

计划应包含以下本地引用：

```text
daytona-local/daytona-api:v0.190.0-local-first-2862ea87
daytona-local/daytona-runner-base:v0.190.0-local-first-2862ea87
daytona-local/daytona-proxy:v0.190.0-local-first-2862ea87
daytona-local/daytona-ssh-gateway:v0.190.0-local-first-2862ea87
```

## 构建

只构建并加载四个产品镜像：

```bash
./scripts/cos-production-images.sh build \
  --repository-prefix daytona-local \
  --output-dir /private/tmp/daytona-product-images/v0.190.0-local-first-2862ea87
```

每个产品构建都显式使用：

```text
docker buildx build --platform linux/amd64 --load
```

脚本还会通过 BuildKit `--label` 写入并在 verify 阶段核验：

```text
org.opencontainers.image.source=https://github.com/ruiinsurance/daytona
org.opencontainers.image.revision=2862ea8776372cd5e9e380a6145d2b08ec6128d4
org.opencontainers.image.version=v0.190.0-local-first-2862ea87
```

重复执行 `build` 会复用 BuildKit 缓存并覆盖相同的不可变本地 tag，但不会删除其他镜像或缓存。产品 Dockerfile 当前引用带版本但未固定 digest 的基础镜像；因此每次实际交付仍应以 `IMAGE-MANIFEST.tsv` 中记录的 image ID 和 tar checksum 为准。

如果 Docker daemon 配置的 Docker Hub mirror 无法拉取官方基础镜像，可以显式改用另一个 Docker Official Images mirror。例如 Public ECR 的只读 mirror：

```bash
./scripts/cos-production-images.sh build \
  --repository-prefix daytona-local \
  --base-image-prefix public.ecr.aws/docker/library \
  --output-dir /private/tmp/daytona-product-images/v0.190.0-local-first-2862ea87
```

如果 Docker build container 访问 Debian/Ubuntu 软件源过慢或超时，还可以传入操作者已建立的、无内嵌凭据的 HTTP(S) build proxy：

```bash
./scripts/cos-production-images.sh build \
  --repository-prefix daytona-local \
  --base-image-prefix public.ecr.aws/docker/library \
  --build-http-proxy http://host.docker.internal:3128 \
  --output-dir /private/tmp/daytona-product-images/v0.190.0-local-first-2862ea87
```

代理值只作为 BuildKit 预定义的 `http_proxy` build argument 传入，不写入交付 manifest，脚本的 `plan` 也只显示启用状态。脚本拒绝含用户名或密码的代理 URL；代理的建立、信任与关闭由操作者在构建流程外负责。

如果 Alpine 官方 CDN 不能稳定交付 build stage 所需的大型编译工具包，可以额外指定一个受信任的只读 HTTPS package mirror：

```bash
./scripts/cos-production-images.sh build \
  --repository-prefix daytona-local \
  --base-image-prefix public.ecr.aws/docker/library \
  --build-http-proxy http://host.docker.internal:3128 \
  --alpine-package-mirror https://mirrors.cloud.tencent.com/alpine \
  --output-dir /private/tmp/daytona-product-images/v0.190.0-local-first-2862ea87
```

该选项只生成一个不交付的 `linux/amd64` Node builder helper，通过 Alpine 的包签名校验安装产品 Dockerfile 原本声明的 `python3`、`py3-setuptools`、`make`、`g++` 和 `git`。helper 随后恢复原始 `/etc/apk/repositories`，再作为 `node:22-alpine` named build context 供三个 Go 产品的 build stage 使用。最终 Runner、Proxy 和 SSH Gateway runtime 仍来自各自产品 Dockerfile 声明并经 Docker Official Images mirror 解析的原始基础镜像；helper 不会被 export。镜像站属于构建信任边界，只有在操作者确认其同步和治理策略后才应启用。

## 核验

```bash
./scripts/cos-production-images.sh verify \
  --repository-prefix daytona-local \
  --output-dir /private/tmp/daytona-product-images/v0.190.0-local-first-2862ea87
```

`inspect` 是 `verify` 的别名。identity gate 会逐镜像检查：

- `Os=linux`、`Architecture=amd64`；
- 完整不可变本地引用可 inspect；
- OCI source、revision、version；
- Entrypoint 和 Healthcheck 与产品 Dockerfile 一致；
- 上表中的产品文件存在且非空；
- Runner、Proxy、SSH Gateway 的二进制是 x86-64 ELF。

核验不启动正式服务，也不执行镜像入口。脚本仅创建临时 stopped container 并复制文件，随后只删除自己创建的临时 container 及其匿名 volume。

## 分包导出

export 会先重新执行完整 identity gate。输出目录必须不存在，防止静默覆盖已有交付：

```bash
./scripts/cos-production-images.sh export \
  --repository-prefix daytona-local \
  --output-dir /private/tmp/daytona-product-images/v0.190.0-local-first-2862ea87
```

也可以从空输出目录一次完成全部阶段：

```bash
./scripts/cos-production-images.sh all \
  --repository-prefix daytona-local \
  --output-dir /private/tmp/daytona-product-images/v0.190.0-local-first-2862ea87
```

输出包括：

```text
api_v0.190.0-local-first-2862ea87_linux-amd64.tar
runner_v0.190.0-local-first-2862ea87_linux-amd64.tar
proxy_v0.190.0-local-first-2862ea87_linux-amd64.tar
ssh-gateway_v0.190.0-local-first-2862ea87_linux-amd64.tar
IMAGE-MANIFEST.tsv
FILE-MANIFEST.sha256
```

`IMAGE-MANIFEST.tsv` 记录组件、base/product 角色、完整镜像引用、平台、image ID、固定提交、版本、Dockerfile、target、产品路径、tar 文件名和字节数。`FILE-MANIFEST.sha256` 覆盖四个 tar 和 `IMAGE-MANIFEST.tsv`；它不包含自身，因为自校验文件无法包含稳定的自身摘要。

脚本先通过同级锁目录串行化同一输出目标，再在输出目录同级创建临时 staging。四个 tar、两个 manifest 及 SHA-256 回验全部完成后，才通过一次目录改名发布最终输出；改名后还会从最终路径再执行一次 SHA-256 回验。最终回验成功前，该目录仍由当前进程跟踪，任一阶段失败都会清理 staging、已改名但未验收的最终目录和本进程持有的锁，不留下看似完整的部分交付目录；若发现同目标锁已存在，脚本会立即拒绝并要求操作者先确认是否仍有导出进程，不能擅自删除锁。

Linux 回验：

```bash
cd /private/tmp/daytona-product-images/v0.190.0-local-first-2862ea87
sha256sum -c FILE-MANIFEST.sha256
```

macOS 回验：

```bash
cd /private/tmp/daytona-product-images/v0.190.0-local-first-2862ea87
shasum -a 256 -c FILE-MANIFEST.sha256
```

## ARM Mac 注意事项

Docker Desktop 的 Buildx builder 必须列出 `linux/amd64`。构建阶段可能通过 binfmt/QEMU 执行 amd64 build container，明显慢于原生 amd64 主机。

交付核验不依赖运行产品入口：`docker image inspect` 检查镜像身份，`docker create` + `docker cp` 检查产品文件。不要因为 ARM 宿主机不能直接运行 amd64 服务，就把架构不匹配误判成镜像内容失败。只有另行验证 binfmt/QEMU 可用并明确需要运行时探针时，才应执行容器进程。

## 映射到 SWR

建议的目标 prefix 是：

```text
swr.cn-east-3.myhuaweicloud.com/ruiinsurance
```

可以在构建时直接使用该 prefix 生成本地 tag；这仍不会 push：

```bash
./scripts/cos-production-images.sh build \
  --repository-prefix swr.cn-east-3.myhuaweicloud.com/ruiinsurance \
  --output-dir /private/tmp/daytona-product-images/v0.190.0-local-first-2862ea87
```

也可以以后从 `daytona-local` 逐个 retag：

```bash
VERSION=v0.190.0-local-first-2862ea87
SWR=swr.cn-east-3.myhuaweicloud.com/ruiinsurance

docker tag daytona-local/daytona-api:${VERSION} ${SWR}/daytona-api:${VERSION}
docker tag daytona-local/daytona-runner-base:${VERSION} ${SWR}/daytona-runner-base:${VERSION}
docker tag daytona-local/daytona-proxy:${VERSION} ${SWR}/daytona-proxy:${VERSION}
docker tag daytona-local/daytona-ssh-gateway:${VERSION} ${SWR}/daytona-ssh-gateway:${VERSION}
```

以下 push 命令只可在另行获得明确授权、由操作者独立完成 registry 登录并核对目标项目后执行。本交付脚本没有 push 或 login 功能：

```bash
docker push ${SWR}/daytona-api:${VERSION}
docker push ${SWR}/daytona-runner-base:${VERSION}
docker push ${SWR}/daytona-proxy:${VERSION}
docker push ${SWR}/daytona-ssh-gateway:${VERSION}
```

不要把 registry 用户名、密码、token 或 Docker credential 文件写入交付目录、Issue、终端日志或 manifest。

## 逐包传输与磁盘回收

1. 在源机器执行完整 `FILE-MANIFEST.sha256` 回验。
2. 每次只传输一个 tar，以及 `IMAGE-MANIFEST.tsv` 和 `FILE-MANIFEST.sha256`。
3. 在目标机器对该 tar 执行 SHA-256 比对，再运行 `docker load --input <tar>`。
4. inspect 加载后的完整不可变引用、平台、OCI revision 和 image ID。
5. 只有在目标端校验完成并记录证据后，才删除源端已经传输完成的单个 tar。

示例：

```bash
shasum -a 256 api_v0.190.0-local-first-2862ea87_linux-amd64.tar
# 传输并在目标端核验后：
rm -- api_v0.190.0-local-first-2862ea87_linux-amd64.tar
```

不要一次删除整个输出目录；保留 manifest 和 checksum，直到全部四个镜像在目标端完成核验。

## 范围边界

本流程不构建或交付：

- Suna 派生 COS Runner；
- Suna API/Web；
- Daytona sandbox/default snapshot；
- devcontainer 镜像；
- 多架构 manifest。

本流程不连接 COS、Postgres、Redis、Dex、`prod01` 或 `prod02`，也不读取生产 Secret。COS 参数、`mount-s3 --prefix` 参数顺序、对象布局和删除语义继续以 [COS_SINGLE_BUCKET_VOLUMES.md](COS_SINGLE_BUCKET_VOLUMES.md) 为准。
