# 界面音效来源与授权

## 宝石碰撞音效

原始素材：Kenney 的 Impact Sounds 1.0，`impactGlass_light_000/001/002.ogg`。

来源：https://kenney.nl/assets/impact-sounds

授权：CC0 1.0 — https://creativecommons.org/publicdomain/zero/1.0/

处理：玻璃碰撞采样裁至 110 毫秒，以 1.4 倍速略微升调，合并为单声道；
通过 1.4 kHz 高通削弱低频碰撞感、8.2 kHz 低通柔化尖锐高频，加快尾音衰减，
降低峰值响度并添加淡入淡出，呈现轻细、短促的晶体碰撞声。
输出为 `gem-1.wav`、`gem-2.wav`、`gem-3.wav`。原始声明见 KENNEY-LICENSE.txt。

## 输入宝石旋律

以以上 CC0 碰撞采样作为短促起音，叠加由项目脚本合成的定音共鸣。
基础音高为 C5、D5、E5、G5、A5、C6；高频共鸣略带非整数倍频率并更快衰减，
形成清脆的接触声和短余音。每份采样为 380 毫秒，末尾平滑衰减至零。
输出为 `gem-note-*.wav`，没有使用额外录音素材。

全部成品为 32 kHz / 16 bit 单声道 WAV，随应用离线分发。
完整处理入口为 `scripts/prepare-ui-sounds.cjs`；已有碰撞采样时可直接运行
`node scripts/prepare-gem-notes.mjs` 重新生成有音高的碰撞声。

输入间隔小于 180 毫秒时使用轻快级进乐句，180～650 毫秒使用舒展乐句，
650～1600 毫秒使用收束乐句；停顿至少 1600 毫秒后回到 C5 开始新乐句。
每次文字提交只播放一个音，按钮悬停和设置试听独立于输入乐句。
