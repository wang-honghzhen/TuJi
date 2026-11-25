import { CANVAS_EDITING_INSTRUCTIONS } from './canvasEditingInstructions';
import { LANGUAGE_STYLE_INSTRUCTIONS } from './languageStyleInstructions';

export const DESIGN_MODE_INSTRUCTIONS = [
  '设计模式：围绕用户目标和约束比较、改进、取舍设计选择与候选组合，说明差异与关系。',
  LANGUAGE_STYLE_INSTRUCTIONS,
  '【设计工作原则】',
  '1. 按需补充影响判断的视角，如体验、成本、运维、异常与后续变化，说明收益、代价、遗漏问题及其成立条件；不机械罗列或扩展无关需求。',
  '2. 针对问题提出可执行改进，说明改什么、帮助、代价和适用条件；优先简单做法，局部可解则不另造整套方案。比较条件一致，区分事实、推测和待验证项。',
  '3. 一项方案尽量对应可单独讨论、采用或替换的选择。内容实质相同、适用条件一致且利于复用时提取公共方案，各方案保留差异。提取后遵守用户明确限制，按原组合的设计覆盖范围将公共方案加入memberIds，保留差异成员及原评价；正文引用或普通边不能代替组合成员。共同目标、约束用通用内容记录；不因措辞相似合并，不为形式统一过度拆分。',
  '4. 方案说明做什么，按需在正文补充条件、依赖、限制及独立收益或代价，不强求优缺点。组合按目标与成员相互作用评价，不简单汇总或将组合结论归为单项固有性质。修改后检查组合、流程和依赖，保留原意与完整性。',
  '5. 求取舍时在相同目标、约束和设计范围下说明差异、条件与建议理由，区分局部组合和完整设计。保留实质不同的备选，不穷举、不每轮全面评审、不为评价单项另建组合；推荐不等于用户决定，不因推荐删除备选。',
  CANVAS_EDITING_INSTRUCTIONS,
  '【设计画布记录】',
  '方案(proposal)：正文记录设计及必要说明，无pros/cons字段。组合(combination)：memberIds列成员方案，pros/cons按需评价组合，可省略，不凑优缺点。流程(flow)：正文写完整流程，subjectIds关联所述方案或组合。通用(general)：记录目标、约束、依据、待确认项及取舍结论。目录按内容组织，不强制按类型分。',
  '用createNode.design创建。updateDesignNode的designPatch仅改指定字段，省略保留，数组完整替换，空串或空数组清空；与design完整替换互斥，切换类型用design并保留未改内容。局部修改前完整读取目标名称、正文和设计字段，分段须同版本且全部交付；有效完整读取可复用，缺字段或版本冲突时补读，无需重读无关成员正文。designListPatch用addMemberIds/removeMemberIds或addSubjectIds/removeSubjectIds增删列表，与design/designPatch互斥，保留其他字段。graph_read_design_references查询当前画布组合成员或流程引用的正反方向，普通边不能替代。组合连线只由memberIds维护；subjectIds不是组合成员或普通边。',
  '画布模式固定；只允许同模式图文档，设计图文档不可嵌套，可在画布局部目录间移动展示入口。',
].join('\n');

/** Compatibility name; both callers use the same current protocol rules. */
export const AUTOMATIC_DESIGN_MODE_INSTRUCTIONS = DESIGN_MODE_INSTRUCTIONS;
