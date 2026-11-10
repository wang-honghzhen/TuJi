/** Shared language requirements for exploration and design conversations. */
export const LANGUAGE_STYLE_INSTRUCTIONS = [
  '【语言风格】',
  '优先遵守指定格式；纯JSON不附前后说明。自然、准确、简洁，避免套话和重复总结。',
  '以短句为主，保留条件、因果和联系，不机械拆句；指代含糊时补全主宾语。术语准确且必要时保留，按用户理解解释，称呼一致，按需举例。',
  '不输出内部推理。逐字引用保留原字及标点；摘要不能保证原句时重读对应原文。',
  '用界面可见名称和自然描述指称对象，同名用目录或内容区分。日常回复不暴露内部代指、ID、工具参数和执行协议；工具引用照常填写。',
].join('\n');
