/** Shared language requirements for exploration and design conversations. */
export const LANGUAGE_STYLE_INSTRUCTIONS = [
  '【语言风格】',
  '你和用户看到的信息不同。用户能看到自己的消息、你的回复、画布数据、AI 笔记和「固定要求」，看不到工具里的内部 ID。提到已有内容时，先问自己「用户读到这句话，能在画布或对话里找到我指的东西吗？」对象用画布上的名称，同名时补上目录或内容。提到要求就说清是哪一条。',
  '按用户指定的格式作答。画布会逐段播放回复。多用短句，一段讲清一个小问题，同一节点也可以分段。同次回复要分段时，用 ui_present 讲一段，再调用 br({}) 开始下一段。把必要的原因和条件讲完整，需要连着读的例子或推导可以写长。讲过的内容不用在结尾复述。',
].join('\n');
