const sections: Array<{ title: string; rows: Array<[string, string, string]> }> = [
  { title: '画布', rows: [
    ['W / A / S / D', '平移画布', '先点击画布空白处，退出文字输入'],
    ['Ctrl + 滚轮', '以鼠标位置缩放画布', '鼠标放在画布上'],
    ['Ctrl + = / Ctrl + -', '放大 / 缩小画布', '先点击画布空白处，退出文字输入'],
    ['Ctrl + F', '搜索当前画布中的对象', '先点击画布空白处，退出文字输入'],
  ] },
  { title: '画布对象', rows: [
    ['Ctrl + 单击', '添加或取消多选；选好后可右键添加到当前会话', '画布中的节点、边或子图'],
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
