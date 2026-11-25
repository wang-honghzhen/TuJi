const sections: Array<{ title: string; rows: Array<[string, string, string]> }> = [
  { title: '视图与关系粒度', rows: [
    ['1 / 2 / 3', '二维 / 分层三维 / 嵌套球体', '保留当前选择和各子图的展开状态'],
    ['V / Shift + V', '切换到下一个 / 上一个视图', '三个视图'],
    ['4', '查看最近一次单击对象的邻域', '单击子图可查看全部层级和跨出子图的边。Ctrl 多选保留焦点，再按 4 返回全显示'],
    ['5', '仅显示已选对象', '支持 Ctrl 多选。选中子图会带上内部内容和跨子图边，再按 5 返回全显示'],
    ['空格 · 双击标题或汇总线', '展开或收缩当前子图或关系', '按空格操作选中对象，双击操作指针下的对象'],
    ['G', '调整单个子图或关系', '打开粒度面板，可逐条展开成员或重新显示隐藏关系'],
    ['Shift + 空格 / Shift + R', '收放全部子图 / 收束或展开跨子图边', '三个视图'],
    ['I / X / B', '切换子图内边 / 跨子图边 / 画布外边', '三个视图'],
  ] },
  { title: '二维画布', rows: [
    ['拖动空白处 · W / A / S / D', '平移画布', '退出文字输入后，在二维画布中使用'],
    ['Ctrl + 滚轮', '以鼠标位置缩放画布', '鼠标放在画布上'],
    ['拖动子图边框', '移动整个子图', '从子图边框开始拖动'],
    ['Alt + 悬停在子图空白处', '预览子图详情', '展开的子图内'],
    ['Ctrl + = / Ctrl + -', '放大 / 缩小画布', '先点击画布空白处，退出文字输入'],
    ['Home', '适应画布', '退出文字输入后，在二维画布中使用'],
  ] },
  { title: '三维画布', rows: [
    ['拖空白 · Alt + 左拖 · Shift + 中拖 · 方向键', '旋转视角', 'Alt 加左拖也可从节点上开始'],
    ['中键拖动 · Shift + 左拖 · 右键拖动 · Shift + 方向键', '平移视角', '中键指按住鼠标滚轮'],
    ['左键拖节点或子图边框', '在对象所属平面移动', '分层视图可编辑平面位置，球体视图拖点旋转视角'],
    ['右键单击', '打开画布编辑菜单', '可创建节点、子图或关系'],
    ['滚轮 · + / −', '放大 / 缩小', '滚轮以鼠标位置为中心，按键以视图中心为准'],
    ['F', '聚焦选中的节点、子图或关系', '旋转时，可见的选中对象保持在原来的屏幕位置'],
    ['选中起点 · Ctrl 加选终点', '追踪两点路径', '多层级三维中可沿当前可见的关系找最短路径，点击步骤可定位该段关系'],
    ['Home', '适应全图', '三维场景'],
    ['Esc', '取消选中并收起详情', '三维场景'],
  ] },
  { title: '画布对象', rows: [
    ['Ctrl + F', '搜索当前画布中的对象', '二维或三维，退出文字输入后使用'],
    ['Alt + 单击', '固定对象详情，点击字段可编辑', '三个视图均可使用，也可选中节点或边，再点工具栏的「编辑」'],
    ['右键', '创建节点、边或子图', '二维画布空白处'],
    ['Ctrl + 单击', '添加或取消选择。右键加入会话时只带上手动选中的对象。', '节点、边或子图的边框'],
    ['Ctrl + 单击空白处', '退出多选', '三个视图均可使用'],
    ['单击对象', '将该对象移到视野中央并查看它的邻域', '子图可以在展开或收起时选中'],
    ['按住 Alt + 鼠标移入', '临时预览对象详情', '退出文字编辑后，将鼠标移到对象上'],
  ] },
  { title: '笔记', rows: [
    ['Ctrl + F', '搜索用户笔记的文字或目录路径', '先点击笔记正文，让焦点进入笔记'],
  ] },
];

export function ShortcutReference() {
  return <div className="ai-column" data-shortcut-reference>
    <div className="ai-settings-intro"><h3>常用快捷键</h3><p className="ai-muted">请先关闭设置、返回工作区，再在对应区域使用。画布键盘操作前，请退出文字输入。</p></div>
    {sections.map(section => <section className="ai-card ai-column" key={section.title}><h3>{section.title}</h3>
      <div className="new-scroll" style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, textAlign: 'left' }}>
        <thead><tr>{['按键', '功能', '生效位置'].map(label => <th key={label} style={{ padding: '8px', color: '#aeb8cb' }}>{label}</th>)}</tr></thead>
        <tbody>{section.rows.map(([key, action, scope]) => <tr key={key + scope} style={{ borderTop: '1px solid #ffffff12' }}>
          <td style={{ padding: '10px 8px', minWidth: 140 }}><kbd>{key}</kbd></td><td style={{ padding: '10px 8px' }}>{action}</td><td className="ai-muted" style={{ padding: '10px 8px' }}>{scope}</td>
        </tr>)}</tbody>
      </table></div>
    </section>)}
  </div>;
}
