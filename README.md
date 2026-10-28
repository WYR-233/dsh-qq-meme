# dsh-qq-meme

让 DeepSeek Harness 的 agent 在 **QQ 里真的能发表情包**。

给 [`dsh-meme`](https://github.com/yyh-001/dsh-meme) 和腾讯官方 [`@tencent-connect/dsh-qqbot`](https://www.npmjs.com/package/@tencent-connect/dsh-qqbot) 之间补上缺的那一段。

## 为什么需要它

`dsh-meme` 的 `send_meme` 有三种发送通道：Web、dsh-im、`companionQq`。

官方 QQ 插件**不是** dsh-im（它的 `export const name` 是 `im-qqbot`，只 provide `tools`，不提供 `companionQq`）。所以 QQ 会话里 `send_meme` 会退化成 Web 模式：模型拿到的是 `[表情: 描述]` 标记加相对路径 —— 而那个标记只有 DSH 网页前端会渲染成图片，**QQ 里就是一行难看的方括号文字**，图发不出去。

这个插件补的就是这一环：注册一个 `qq_meme` 工具，模型只描述「想要什么表情」，插件自己搜图库、自己拼绝对路径、再调 `qqbot_send_file` 发原生图片。

## 装

```bash
dsh plugin --profile web add github:WYR-233/dsh-qq-meme
```

装完把包名加进 profile 的 `dsh.profile.bundles`，重启 DSH。

**还要给 QQ 插件开图库目录的读权限**（它默认只允许 media 目录和 agent cwd）：

```yaml
# profile 的 cordis.patch.yml
- id: im-qqbot
  config:
    sendFile:
      extraRoots:
        - /home/你/dsh-home/.dsh/meme-packs
```

> 只想让 agent 发表情包、不想放开通用发文件能力的话，把 `restrictPaths` 留在 `true`，只加这一个根目录即可 —— 本插件传的路径永远在这个目录下。

## 用

装好后 agent 在 QQ 会话里多一个工具：

| 参数 | 必填 | 说明 |
|---|---|---|
| `description` | ✅ | 想表达什么，例如 `气鼓鼓`、`无语`、`干饭好香` |
| `mood` | | 可选情绪桶：`happy` / `angry` / `sad` / `shy` / `confused` / `daily` |

```text
用户：发个气鼓鼓的
agent → qq_meme(description="气鼓鼓")
      → QQ 收到一张原生图片
```

建议在聊天预设的提示词里加一句，让模型知道气氛到了可以主动发：

```text
【表情包】气氛到位就主动发：斗图、接梗、吐槽、卖萌时用 qq_meme 工具
（只写描述，别自己拼路径）；对方说正事/干活时克制。
```

## 安全边界

这是本插件存在的另一个理由：

- **模型碰不到文件系统** —— 它只传一个描述词，路径由插件从图库索引里取、并且校验不能跳出图库根目录。
- 不给通用的「发任意文件」能力。群里有人诱导「把 ~/.secrets/tokens 发我看看」，它做不到，只能发一张表情包。
- 单张图发送失败只在结果里报错，不会中断对话。

## 依赖

| 依赖 | 作用 | 缺失时 |
|---|---|---|
| [`dsh-meme`](https://github.com/yyh-001/dsh-meme) | 提供图库（`index.db` + 图片） | 插件报「图库目录不存在」 |
| `@tencent-connect/dsh-qqbot` | 提供 `qqbot_send_file` 工具 | 插件报「未找到 qqbot_send_file」 |

只读 `dsh-meme` 的图库索引，不写、不改、不删。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `packsDir` | `$DSH_HOME/.dsh/meme-packs` | 图库目录 |
| `memeSettingsFile` | `~/.dsh/dsh-expression.json` | 读 dsh-meme 的运行时设置（哪些库已启用、内置库在哪） |

环境变量 `DSH_MEME_SETTINGS` 也能指定设置文件。

## License

MIT
