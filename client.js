window.__ModuleLoader__.load({
  id: '@local/dsh-memory',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const TONE = {
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    };

    const INPUT = {
      flex: '1 1 auto',
      minWidth: 0,
      font: 'inherit',
      fontSize: 13,
      lineHeight: '20px',
      padding: '4px 8px',
      color: 'var(--dsw-alias-label-primary)',
      background: 'var(--dsw-alias-bg-base)',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: 'var(--dsw-radius-md)',
      boxSizing: 'border-box',
    };

    const BUTTON = {
      font: 'inherit',
      fontSize: 12,
      lineHeight: '20px',
      padding: '2px 10px',
      color: 'var(--dsw-alias-label-primary)',
      background: 'var(--dsw-alias-bg-layer-1)',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: 'var(--dsw-radius-md)',
      cursor: 'pointer',
      flex: '0 0 auto',
    };

    const CARD = {
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      padding: '14px 16px',
      // l1 是 4% 黑，白底上几乎看不见；卡片轮廓用 l2（10% 黑）才看得清。
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: 'var(--dsw-radius-md)',
      background: 'var(--dsw-alias-bg-layer-1)',
    };

    // 锁定的记忆：轮廓不变，左边加一道更深的竖线、底色换一档，文件名前的锁加深。
    const CARD_LOCKED = {
      ...CARD,
      background: 'var(--dsw-alias-bg-layer-2)',
      borderLeft: '3px solid var(--dsw-alias-border-l4)',
    };

    // 主动作按钮（新建记忆）要比普通按钮明显一档：l2 轮廓 + 卡片底。
    const BUTTON_STRONG = {
      ...BUTTON,
      border: '1px solid var(--dsw-alias-border-l2)',
    };

    const CHECK_ICON = h(
      'svg',
      {
        width: 12,
        height: 12,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      h('path', { d: 'M20 6L9 17l-5-5' }),
    );

    const CHEVRON_ICON = h(
      'svg',
      {
        width: 12,
        height: 12,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      h('path', { d: 'M6 9l6 6 6-6' }),
    );

    const HOURGLASS_ICON = h(
      'svg',
      {
        width: 13,
        height: 13,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      h('path', { d: 'M7 3h10' }),
      h('path', { d: 'M7 21h10' }),
      h('path', { d: 'M8 3c0 4 8 5 8 9s-8 5-8 9' }),
      h('path', { d: 'M16 3c0 4-8 5-8 9s8 5 8 9' }),
    );

    // 大脑图标：菜单行要的是「组件」，行内提示要的是「元素」，两种都给。
    function BrainGlyph(props) {
      const size = props && props.size ? props.size : 14;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M9.5 3.5A2.8 2.8 0 0 0 7 6.3a2.9 2.9 0 0 0-1.4 5.1A3 3 0 0 0 8 16.6a3 3 0 0 0 4 1.9V4.9a2.5 2.5 0 0 0-2.5-1.4Z' }),
        h('path', { d: 'M14.5 3.5A2.8 2.8 0 0 1 17 6.3a2.9 2.9 0 0 1 1.4 5.1A3 3 0 0 1 16 16.6a3 3 0 0 1-4 1.9' }),
        h('path', { d: 'M12 5v13.5' }),
      );
    }
    const BRAIN_ICON = h(BrainGlyph, null);

    const LOCK_ICON = h(
      'svg',
      {
        width: 12,
        height: 12,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      h('rect', { x: 4, y: 11, width: 16, height: 10, rx: 2 }),
      h('path', { d: 'M8 11V7a4 4 0 0 1 8 0v4' }),
    );

    const TRASH_ICON = h(
      'svg',
      {
        width: 13,
        height: 13,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      h('path', { d: 'M3 6h18' }),
      h('path', { d: 'M9 6V4h6v2' }),
      h('path', { d: 'M6 6l1 14h10l1-14' }),
    );

    const PRE = {
      margin: 0,
      padding: '10px 12px',
      maxHeight: 280,
      overflow: 'auto',
      font: 'inherit',
      fontSize: 13,
      lineHeight: '1.7',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      background: 'var(--dsw-alias-bg-base)',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: 'var(--dsw-radius-md)',
      color: 'var(--dsw-alias-label-primary)',
    };

    const COL = { flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 };
    const COL_HINT = { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' };

    const FORM_ROW = { display: 'flex', alignItems: 'center', gap: 8 };
    const FORM_LABEL = { flex: '0 0 auto', width: 64, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' };
    // 分类就是首关键词；和模型的硬约束同一个清单，「项目记忆」只有人工通道能建。
    const CATEGORIES = ['资料', '教训', '说明书', '项目记忆', '其它'];

    function formatTime(iso) {
      return iso ? String(iso).slice(0, 16).replace('T', ' ') : '未运行';
    }

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
      return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
    }

    /**
     * 行级 diff（LCS）：左边只标「删掉的」，右边只标「新增的」，相同行两边都正常显示。
     * 行数乘积超过 64 万时退化成整块对比，避免把设置页卡死。
     */
    function lineDiff(before, after) {
      const a = String(before).split(/\r?\n/);
      const b = String(after).split(/\r?\n/);
      const n = a.length;
      const m = b.length;
      if (n * m > 640000) {
        return {
          left: a.map((text) => ({ kind: 'del', text })),
          right: b.map((text) => ({ kind: 'add', text })),
        };
      }
      const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
      for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
          dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
      const left = [];
      const right = [];
      let i = 0;
      let j = 0;
      while (i < n && j < m) {
        if (a[i] === b[j]) {
          left.push({ kind: 'same', text: a[i] });
          right.push({ kind: 'same', text: b[j] });
          i += 1;
          j += 1;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
          left.push({ kind: 'del', text: a[i] });
          i += 1;
        } else {
          right.push({ kind: 'add', text: b[j] });
          j += 1;
        }
      }
      while (i < n) {
        left.push({ kind: 'del', text: a[i] });
        i += 1;
      }
      while (j < m) {
        right.push({ kind: 'add', text: b[j] });
        j += 1;
      }
      return { left, right };
    }

    function viewOf(data, error) {
      if (error) return { label: '插件异常', tone: 'error' };
      if (!data) return { label: '读取中', tone: 'idle' };
      if (data.state === 'pending') return { label: '待审批', tone: 'warn' };
      if (data.state === 'failed') {
        return /DSH_AUTOMATION_API_KEY/.test(data.detail || '')
          ? { label: 'API 未配置', tone: 'error' }
          : { label: '运行异常', tone: 'error' };
      }
      return { label: '正常', tone: 'ok' };
    }

    /**
     * 把命中的关键词标出来（搜索时用）。返回 React 节点数组，没命中就原样返回文本。
     * @param text - 要显示的原文。
     * @param query - 搜索词。
     * @returns 文本或带高亮 span 的数组。
     */
    function highlight(text, query) {
      const raw = String(text ?? '');
      const q = String(query || '').trim();
      if (!q || !raw) return raw;
      const lower = raw.toLowerCase();
      const needle = q.toLowerCase();
      const parts = [];
      let from = 0;
      let idx = lower.indexOf(needle);
      let key = 0;
      while (idx >= 0) {
        if (idx > from) parts.push(raw.slice(from, idx));
        parts.push(
          h(
            'span',
            {
              key: `hl-${key}`,
              style: {
                background: 'var(--dsw-alias-interactive-bg-hover-accent)',
                borderRadius: 3,
                padding: '0 1px',
                fontWeight: 600,
              },
            },
            raw.slice(idx, idx + q.length),
          ),
        );
        key += 1;
        from = idx + q.length;
        idx = lower.indexOf(needle, from);
      }
      if (from < raw.length) parts.push(raw.slice(from));
      return parts.length ? parts : raw;
    }

    const dot = (color) => ({ width: 8, height: 8, borderRadius: '9999px', background: color, flex: '0 0 auto' });
    const stop = (ev) => ev.stopPropagation();

    function Toggle(props) {
      const { checked, onChange } = props;
      return h(
        'label',
        {
          title: checked ? '已启用：关键词进大纲，模型可按需读' : '已停用：模型看不到，也读不到',
          onClick: stop,
          onDoubleClick: stop,
          style: {
            position: 'relative',
            width: 34,
            height: 18,
            flex: '0 0 auto',
            cursor: 'pointer',
            borderRadius: '9999px',
            background: checked ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)',
            transition: 'background .15s',
          },
        },
        h('input', {
          type: 'checkbox',
          checked,
          onChange,
          style: { position: 'absolute', inset: 0, opacity: 0, margin: 0, cursor: 'pointer' },
        }),
        h('span', {
          style: {
            position: 'absolute',
            top: 2,
            left: checked ? 18 : 2,
            width: 14,
            height: 14,
            borderRadius: '9999px',
            background: '#fff',
            transition: 'left .15s',
            pointerEvents: 'none',
          },
        }),
      );
    }

    /**
     * 分类选择器：原生 <select> 的弹出层是系统控件，跟 DSH 的菜单材质完全不搭，
     * 所以自己画一个——触发按钮长得像输入框，弹出层用官方菜单 token（menu-surface-fill / border-l2 /
     * radius-md / shadow-lv3 / interactive-bg-hover）。
     */
    function CategoryPicker(props) {
      const { value, onChange } = props;
      const [open, setOpen] = React.useState(false);
      const [hover, setHover] = React.useState(null);
      return h(
        'div',
        { style: { position: 'relative', flex: '0 0 auto', width: 132 } },
        h(
          'button',
          {
            type: 'button',
            onClick: () => setOpen((v) => !v),
            onKeyDown: (ev) => {
              if (ev.key === 'Escape') setOpen(false);
            },
            'aria-haspopup': 'listbox',
            'aria-expanded': open,
            style: {
              ...INPUT,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 6,
              cursor: 'pointer',
              textAlign: 'left',
            },
          },
          h('span', null, value),
          h('span', { style: { display: 'inline-flex', color: 'var(--dsw-alias-label-secondary)' } }, CHEVRON_ICON),
        ),
        open
          ? [
              // 透明遮罩负责“点外面就收起”，比全局事件监听稳。
              h('div', {
                key: 'mask',
                onClick: () => setOpen(false),
                style: { position: 'fixed', inset: 0, zIndex: 19, background: 'transparent' },
              }),
              h(
                'div',
                {
                  key: 'panel',
                  role: 'listbox',
                  style: {
                    position: 'absolute',
                    top: 'calc(100% + 4px)',
                    left: 0,
                    minWidth: '100%',
                    padding: 4,
                    zIndex: 20,
                    background: 'var(--dsw-menu-surface-fill)',
                    backdropFilter: 'var(--dsw-menu-backdrop-filter)',
                    WebkitBackdropFilter: 'var(--dsw-menu-backdrop-filter)',
                    border: '1px solid var(--dsw-alias-border-l2)',
                    borderRadius: 'var(--dsw-radius-md)',
                    boxShadow: 'var(--dsw-shadow-lv3)',
                  },
                },
                ...CATEGORIES.map((c) =>
                  h(
                    'div',
                    {
                      key: c,
                      role: 'option',
                      'aria-selected': c === value,
                      onMouseEnter: () => setHover(c),
                      onMouseLeave: () => setHover(null),
                      onClick: () => {
                        onChange(c);
                        setOpen(false);
                      },
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        padding: '6px 10px',
                        borderRadius: 'var(--dsw-radius-sm)',
                        fontSize: 13,
                        lineHeight: '20px',
                        cursor: 'pointer',
                        background: hover === c ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
                        color: 'var(--dsw-alias-label-primary)',
                      },
                    },
                    h('span', null, c),
                    c === value
                      ? h('span', { style: { display: 'inline-flex', color: 'var(--dsw-alias-brand-primary)' } }, CHECK_ICON)
                      : null,
                  ),
                ),
              ),
            ]
          : null,
      );
    }

    /**
     * `/remember` 的运行状态是插件自己的事，不进会话：宿主命令会往历史里写 command 事件，
     * 而这里改成客户端 action，状态只放在输入框下方的一条小提示里。
     */
    const REMEMBER = { status: 'idle', text: '', turns: null, sessionId: '' };
    const REMEMBER_LISTENERS = new Set();

    function setRemember(next) {
      Object.assign(REMEMBER, next);
      for (const listener of REMEMBER_LISTENERS) listener();
    }

    function useRemember() {
      const [, force] = React.useState(0);
      React.useEffect(() => {
        const sync = () => force((n) => n + 1);
        REMEMBER_LISTENERS.add(sync);
        return () => {
          REMEMBER_LISTENERS.delete(sync);
        };
      }, []);
      return { ...REMEMBER };
    }

    /** 调宿主跑一次记忆；只在成功后记下当时的轮计数，用来判断「下一轮」何时开始。 */
    async function runRemember(session) {
      const sessionId = session && session.sessionId ? session.sessionId : '';
      if (!sessionId || REMEMBER.status === 'running') return;
      setRemember({ status: 'running', text: '记忆中', turns: null, sessionId });
      try {
        const res = await fetch('/dsh-memory/remember', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || String(res.status));
        setRemember({
          status: 'done',
          text: `记忆完毕，正文长 ${body.chars ?? 0}`,
          turns: Number.isFinite(body.turns) ? body.turns : null,
        });
      } catch (err) {
        setRemember({ status: 'error', text: `记忆失败：${err && err.message ? err.message : err}`, turns: null });
      }
    }

    /**
     * 输入框控件行里的那一条：记忆中 → 记忆完毕，正文长 N。
     * 成功/失败都挂在这里；只显示发起它的会话，下一次人类发言（轮计数 +1）后自动消失。
     */
    function RememberStatus(props) {
      const state = useRemember();
      const base = state.turns;
      const sessionId = props && props.sessionId ? props.sessionId : '';
      React.useEffect(() => {
        if ((state.status !== 'done' && state.status !== 'error') || !Number.isFinite(base)) return undefined;
        let alive = true;
        const timer = setInterval(async () => {
          try {
            const res = await fetch('/dsh-memory/status', { cache: 'no-store' });
            const next = await res.json();
            if (alive && Number.isFinite(next.turns) && next.turns > base) {
              setRemember({ status: 'idle', text: '', turns: null, sessionId: '' });
            }
          } catch {
            /* 取不到状态就等下一拍 */
          }
        }, 2000);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [state.status, base]);

      if (state.status === 'idle' || !state.text) return null;
      // 切到别的对话时不要把这行带过去
      if (state.sessionId && sessionId && state.sessionId !== sessionId) return null;
      const failed = state.status === 'error';
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '2px 4px',
            fontSize: 12,
            lineHeight: '18px',
            color: failed ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)',
          },
        },
        h(
          'span',
          {
            style: {
              display: 'inline-flex',
              color: failed ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-brand-primary)',
            },
          },
          BRAIN_ICON,
        ),
        h('span', null, state.text),
      );
    }

    /** 探针：确认某个槽位到底有没有把我们的组件挂上（排查用，发完就不管）。 */
    function pingDock(slot, props) {
      try {
        fetch('/dsh-memory/dockping', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ slot, sessionId: props && props.sessionId ? props.sessionId : '' }),
        }).catch(() => {});
      } catch {
        /* 探针失败不影响界面 */
      }
    }

    /** 状态条：挂在输入框控件行，挂上时回报一次槽位（排查用）。 */
    const RememberStatusRow = (props) => {
      React.useEffect(() => {
        pingDock('input-right', props);
      }, []);
      return h(RememberStatus, props);
    };

    /**
     * 「记忆」视图：对话界面里的第三个标签页（对话 / 轨迹 / 记忆）。
     * 仿轨迹的形态：左边单行日志，点一行在右侧开详情（来源/类型/关键词/状态/时间/内容），
     * 有 callId 的还能跳回轨迹里那次工具调用。DSH 的轨迹行是固定枚举，第三方加不了行类，
     * 所以做成并列视图。
     */
    const MEMO_OPS = {
      read: { label: '回忆', bg: '#dbeafe', fg: '#1d4ed8' },
      write: { label: '记忆', bg: '#ffd3e4', fg: '#9c1b56' },
      update: { label: '改写', bg: '#fef3c7', fg: '#92400e' },
      delete: { label: '删除', bg: '#fee2e2', fg: '#b91c1c' },
      remember: { label: '对话归纳', bg: '#ede9fe', fg: '#6d28d9' },
    };
    const memoOp = (op) => MEMO_OPS[op] || { label: op || '?', bg: '#e5e7eb', fg: '#374151' };

    function MemoPill({ op }) {
      const cfg = memoOp(op);
      return h(
        'span',
        {
          style: {
            flex: 'none',
            padding: '0 6px',
            borderRadius: 4,
            background: cfg.bg,
            color: cfg.fg,
            fontSize: 11,
            lineHeight: '16px',
          },
        },
        cfg.label,
      );
    }

    /** 详情面板的错误边界：任何渲染异常都显示成一行红字，而不是整块消失。 */
    class MemoBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { err: null };
      }
      static getDerivedStateFromError(err) {
        return { err };
      }
      render() {
        if (this.state.err) {
          return h(
            'div',
            { style: { padding: 12, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } },
            `详情渲染出错：${this.state.err && this.state.err.message ? this.state.err.message : String(this.state.err)}`,
          );
        }
        return this.props.children;
      }
    }

    function MemoDetail({ row, detail, detailError, loading, onClose, onLocate }) {
      const [tab, setTab] = React.useState('overview');
      const data = detail || row;
      const when = (() => {
        const d = new Date(data.ts);
        if (Number.isNaN(d.getTime())) return '';
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
      })();
      const canLocate = Boolean(data.callId && onLocate);
      const source = data.op === 'remember' ? '对话归纳（/remember）' : `工具 memory_${data.op || '?'}`;

      const field = (label, value) =>
        h(
          'div',
          { style: { display: 'flex', gap: 12, alignItems: 'baseline', padding: '3px 0' } },
          h('span', { style: { flex: 'none', width: 64, color: 'var(--dsw-alias-label-secondary)' } }, label),
          h('span', { style: { minWidth: 0, wordBreak: 'break-all' } }, value || '—'),
        );

      const tabs = [
        ['overview', '概览'],
        ['preview', '预览'],
        ['raw', '原始内容'],
      ];

      const body =
        tab === 'overview'
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column' } },
              h(
                'div',
                { style: { display: 'flex', gap: 12, alignItems: 'baseline', padding: '3px 0' } },
                h('span', { style: { flex: 'none', width: 64, color: 'var(--dsw-alias-label-secondary)' } }, '来源'),
                canLocate
                  ? h(
                      'button',
                      {
                        type: 'button',
                        onClick: () => onLocate(data.callId),
                        title: '跳到轨迹里这次工具调用',
                        style: {
                          border: 'none',
                          background: 'transparent',
                          padding: 0,
                          cursor: 'pointer',
                          color: 'var(--dsw-alias-brand-primary, #2563eb)',
                          fontSize: 12,
                          textAlign: 'left',
                        },
                      },
                      `${source} ›`,
                    )
                  : h('span', null, source),
              ),
              field('状态', data.ok === false ? '失败' : '已完成'),
              field('时间', when),
              field('字数', data.chars ? `${data.chars} 字` : ''),
              field('类型', data.cat ? `${data.cat}${data.type ? ` · ${data.type}` : ''}` : data.type),
              field('关键词', data.keywords),
              field('会话', data.sessionId ? String(data.sessionId).slice(0, 8) : ''),
              canLocate
                ? h(
                    'button',
                    {
                      type: 'button',
                      onClick: () => onLocate(data.callId),
                      style: {
                        alignSelf: 'flex-start',
                        marginTop: 8,
                        border: '1px solid var(--dsw-alias-border-l1)',
                        background: 'transparent',
                        color: 'var(--dsw-alias-label-primary)',
                        borderRadius: 4,
                        padding: '2px 8px',
                        fontSize: 12,
                        cursor: 'pointer',
                      },
                    },
                    '在轨迹中定位',
                  )
                : null,
            )
          : null;

      const contentBox = (text) =>
        h(
          'div',
          {
            style: {
              flex: '1 1 auto',
              minHeight: 0,
              overflowY: 'auto',
              border: '1px solid var(--dsw-alias-border-l1)',
              borderRadius: 4,
              padding: '8px 10px',
              background: 'var(--dsw-alias-bg-base)',
              fontSize: 12,
              lineHeight: '19px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            },
          },
          text,
        );

      const panelBody =
        tab === 'preview'
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 auto', minHeight: 0 } },
              h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, data.op === 'delete' ? '被删除的正文' : data.op === 'read' ? '注入给模型的原文' : '写入的正文'),
              contentBox(loading && !detail ? '读取中…' : data.content || '（没有正文）'),
            )
          : tab === 'raw'
            ? contentBox(JSON.stringify(data, null, 2))
            : body;

      return h(
        'div',
        {
          style: {
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            minHeight: 0,
          },
        },
        // 头部：标签 + 第 N 轮 + 关闭
        h(
          'div',
          { style: { flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px 6px' } },
          h(MemoPill, { op: data.op }),
          h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `${data.target}.md${data.turn ? ` · 第 ${data.turn} 轮` : ''}`),
          h(
            'button',
            {
              type: 'button',
              title: '关闭',
              onClick: onClose,
              style: {
                marginLeft: 'auto',
                flex: 'none',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                color: 'var(--dsw-alias-label-secondary)',
                fontSize: 14,
                lineHeight: '20px',
                padding: '0 4px',
              },
            },
            '×',
          ),
        ),
        // 页签：概览 / 预览 / 原始内容
        h(
          'div',
          { style: { flex: 'none', display: 'flex', gap: 16, padding: '0 12px', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
          tabs.map(([id, label]) =>
            h(
              'button',
              {
                key: id,
                type: 'button',
                onClick: () => setTab(id),
                style: {
                  border: 'none',
                  background: 'transparent',
                  padding: '6px 0 5px',
                  cursor: 'pointer',
                  fontSize: 12,
                  color: tab === id ? 'var(--dsw-alias-brand-primary, #2563eb)' : 'var(--dsw-alias-label-secondary)',
                  borderBottom: tab === id ? '2px solid var(--dsw-alias-brand-primary, #2563eb)' : '2px solid transparent',
                },
              },
              label,
            ),
          ),
        ),
        h(
          'div',
          {
            style: {
              flex: '1 1 auto',
              minHeight: 0,
              overflowY: 'auto',
              padding: '10px 12px',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              fontSize: 12,
              lineHeight: '20px',
            },
          },
          detailError && !detail
            ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-state-error-primary)' } }, detailError)
            : null,
          panelBody,
        ),
      );
    }

    /** 单行日志：仿轨迹的「左侧圆点 + 标签 + 名称 + 概要 → 结果」。 */
    function MemoRow({ row, selected, onSelect }) {
      const [hover, setHover] = React.useState(false);
      const summary = (() => {
        const n = row.chars ? `${row.chars} 字` : '';
        if (!n) return '';
        if (row.op === 'read') return `注入 ${n}`;
        if (row.op === 'write') return `写入 ${n}`;
        if (row.op === 'update') return `改写为 ${n}`;
        if (row.op === 'delete') return `删除 ${n}`;
        if (row.op === 'remember') return `归纳 ${n}`;
        return n;
      })();
      return h(
        'div',
        {
          role: 'button',
          tabIndex: 0,
          onClick: onSelect,
          onKeyDown: (ev) => {
            if (ev.key === 'Enter') onSelect();
          },
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            minHeight: 38,
            padding: '0 12px 0 8px',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            background: selected
              ? 'var(--dsw-alias-bg-subtle, rgba(0,0,0,0.06))'
              : hover
                ? 'var(--dsw-alias-bg-subtle, rgba(0,0,0,0.035))'
                : 'transparent',
          },
        },
        // 左侧小圆点：轨迹每行都有，用作视觉锚点
        h('span', {
          style: {
            flex: 'none',
            width: 4,
            height: 4,
            borderRadius: 2,
            background: 'var(--dsw-alias-label-secondary)',
            opacity: 0.45,
            margin: '0 6px 0 4px',
          },
        }),
        h(MemoPill, { op: row.op }),
        h(
          'span',
          {
            style: {
              flex: 'none',
              fontWeight: 500,
              fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
              fontSize: 12,
            },
          },
          `${row.target}.md`,
        ),
        h(
          'span',
          {
            style: {
              flex: '1 1 auto',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              color: 'var(--dsw-alias-label-secondary)',
              fontSize: 12,
            },
          },
          row.keywords || '',
        ),
        summary
          ? h(
              'span',
              {
                style: {
                  flex: 'none',
                  marginLeft: 12,
                  color: 'var(--dsw-alias-label-secondary)',
                  fontSize: 12,
                },
              },
              '→ ',
              summary,
            )
          : null,
      );
    }

    function MemoryCallsView(props) {
      // 槽位 kit 里可能已经有 sessionId，注入同名会触发 assertNoPropOverlap，所以用独立名字。
      const sessionId = String((props && (props.memorySessionId || props.sessionId)) || '');
      const inspectCall = props && typeof props.inspectCall === 'function' ? props.inspectCall : null;
      const [calls, setCalls] = React.useState(null); // null = 还没成功拉到过
      const [error, setError] = React.useState('');
      const [filter, setFilter] = React.useState('all');
      const [selectedRow, setSelectedRow] = React.useState(null); // 直接存行对象，避免 id 对不上
      const [detail, setDetail] = React.useState(null);
      const [detailError, setDetailError] = React.useState('');
      const [loading, setLoading] = React.useState(false);

      React.useEffect(() => {
        let alive = true;
        const load = async () => {
          try {
            const q = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
            const res = await fetch(`/dsh-memory/calls${q}`, { cache: 'no-store' });
            if (!alive) return;
            if (!res.ok) {
              setError(res.status === 404 ? '记忆服务未启用：重启 DSH 后可用' : `记忆服务返回 ${res.status}`);
              return;
            }
            const body = await res.json();
            if (!alive) return;
            if (Array.isArray(body.calls)) {
              // 旧宿主写下的流水没有 id：这里补一个，否则点行找不到对应记录、详情打不开。
              setCalls(body.calls.map((c) => ({ ...c, id: c.id || c.callId || String(c.ts || '') })));
              setError('');
            } else {
              setError('记忆服务返回格式不对');
            }
          } catch {
            if (alive) setError('连不上记忆服务');
          }
        };
        load();
        const timer = setInterval(load, 3000);
        window.addEventListener('focus', load);
        return () => {
          alive = false;
          clearInterval(timer);
          window.removeEventListener('focus', load);
        };
      }, [sessionId]);

      // 客户端再排一次序：宿主是旧代码时可能仍返回倒序，这里保证「老的在上」。
      const allRows = [...(calls || [])].sort((a, b) => {
        const ta = Date.parse(a.ts);
        const tb = Date.parse(b.ts);
        return (Number.isNaN(ta) ? 0 : ta) - (Number.isNaN(tb) ? 0 : tb);
      });
      const rows = filter === 'all' ? allRows : allRows.filter((r) => r.op === filter);
      const FILTERS = [['all', '全部'], ['read', '回忆'], ['write', '记忆'], ['update', '改写'], ['delete', '删除'], ['remember', '对话归纳']];

      const boxRef = React.useRef(null);
      const prevLen = React.useRef(null);
      React.useEffect(() => {
        const el = boxRef.current;
        if (!el || !rows.length) return;
        const first = prevLen.current === null;
        const grew = prevLen.current !== null && rows.length > prevLen.current;
        prevLen.current = rows.length;
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        if (first || (grew && nearBottom)) el.scrollTop = el.scrollHeight;
      }, [rows.length]);

      // 点一行：先拉完整正文（列表里没有），拉不到就退回列表里的轻量字段。
      const selectedKey = selectedRow
        ? String(selectedRow.id || selectedRow.callId || selectedRow.ts || '')
        : '';
      React.useEffect(() => {
        if (!selectedRow || !selectedKey) {
          setDetail(null);
          setDetailError('');
          return undefined;
        }
        let alive = true;
        setLoading(true);
        setDetail(null);
        (async () => {
          try {
            const res = await fetch(`/dsh-memory/call?id=${encodeURIComponent(selectedKey)}`, { cache: 'no-store' });
            const body = await res.json();
            if (!alive) return;
            if (res.ok && body.call) {
              setDetail(body.call);
              setDetailError('');
            } else {
              setDetailError(res.status === 404 ? '详情接口不可用：重启 DSH 后可用' : `详情接口返回 ${res.status}`);
            }
          } catch {
            if (alive) setDetailError('连不上详情接口');
          } finally {
            if (alive) setLoading(false);
          }
        })();
        return () => {
          alive = false;
        };
      }, [selectedKey]);

      const center = {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        padding: '24px 16px',
        fontSize: 12,
      };

      const list = h(
        'div',
        {
          style: {
            flex: '1 1 auto',
            minWidth: 0,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            font: 'inherit',
            fontSize: 12,
            lineHeight: '20px',
            color: 'var(--dsw-alias-label-primary)',
          },
        },
        // 顶部工具条：条数 + 操作类型过滤，模仿轨迹的「时长 / 轮次 / 调用」
        h(
          'div',
          {
            style: {
              flex: 'none',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '5px 12px',
              borderBottom: '1px solid var(--dsw-alias-border-l1)',
            },
          },
          h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginRight: 6 } }, `${allRows.length} 条`),
          ...FILTERS.map(([id, label]) =>
            h(
              'button',
              {
                key: id,
                type: 'button',
                onClick: () => setFilter(id),
                style: {
                  border: 'none',
                  background: filter === id ? 'var(--dsw-alias-bg-subtle, rgba(0,0,0,0.07))' : 'transparent',
                  color: filter === id ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
                  borderRadius: 4,
                  padding: '1px 6px',
                  fontSize: 12,
                  lineHeight: '18px',
                  cursor: 'pointer',
                },
              },
              label,
            ),
          ),
        ),
        h(
          'div',
          {
            ref: boxRef,
            style: {
              flex: '1 1 auto',
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 0,
              padding: '4px 0',
              overflowY: 'auto',
            },
          },
          error
            ? h('div', { style: { marginBottom: 4, padding: '0 12px', fontSize: 11, color: 'var(--dsw-alias-state-error-primary)' } }, error)
            : null,
          rows.length === 0
            ? h('div', { style: { padding: '12px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '该类型暂无记录')
            : null,
          rows.map((row, i) => {
            const key = row.id || `${row.ts}-${i}`;
            return h(MemoRow, {
              key,
              row,
              selected: Boolean(selectedRow && (selectedRow.id || selectedRow.ts) === (row.id || row.ts)),
              onSelect: () => setSelectedRow(row),
            });
          }),
        ),
      );

      if (!allRows.length) {
        if (error) return h('div', { style: { ...center, color: 'var(--dsw-alias-state-error-primary)' } }, error);
        if (calls === null) return h('div', { style: { height: '100%' } });
        return h('div', { style: { ...center, color: 'var(--dsw-alias-label-secondary)', opacity: 0.7 } }, '暂无记忆调用');
      }

      const sel = selectedRow;
      return h(
        'div',
        { style: { display: 'flex', height: '100%', minHeight: 0, position: 'relative', overflow: 'hidden' } },
        list,
        sel
          ? h(
              'div',
              {
                style: {
                  position: 'absolute',
                  top: 0,
                  right: 0,
                  bottom: 0,
                  width: 470,
                  maxWidth: '100%',
                  zIndex: 5,
                  background: 'var(--dsw-alias-bg-base, #fff)',
                  borderLeft: '1px solid var(--dsw-alias-border-l1)',
                  boxShadow: '-8px 0 16px rgba(0, 0, 0, 0.06)',
                  display: 'flex',
                  flexDirection: 'column',
                  minHeight: 0,
                },
              },
              h(
                MemoBoundary,
                null,
                h(MemoDetail, {
                  row: sel,
                  detail,
                  detailError,
                  loading,
                  onClose: () => setSelectedRow(null),
                  onLocate: inspectCall,
                }),
              ),
            )
          : null,
      );
    }
    function StatusRow(props) {
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            padding: '10px 0',
            borderBottom: props.last ? 'none' : '1px solid var(--dsw-alias-border-l1)',
          },
        },
        h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, props.label),
        h('span', { style: { color: 'var(--dsw-alias-label-primary)', textAlign: 'right' } }, props.children),
      );
    }

    function MemorySettings() {
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState(false);
      const [draft, setDraft] = React.useState({});
      const [editing, setEditing] = React.useState(null);
      const [reviewing, setReviewing] = React.useState(null);
      const [expanded, setExpanded] = React.useState(null);
      const [note, setNote] = React.useState({});
      const [creating, setCreating] = React.useState(false);
      const [form, setForm] = React.useState({ name: '', category: '资料', extra: '', description: '', body: '' });
      const [banner, setBanner] = React.useState('');
      const [confirmDel, setConfirmDel] = React.useState(null);
      const [query, setQuery] = React.useState('');
      const [search, setSearch] = React.useState(null); // { q, matches:[{file,hits,snippets}] }
      const [collapsed, setCollapsed] = React.useState({}); // 分类 → true 表示折叠
      const [compressing, setCompressing] = React.useState(false);
      // 记忆状态同时在这里显示一份：输入框那条万一没挂上，设置页也能看到结果。
      const rememberState = useRemember();

      const applyData = (next) => {
        setData(next);
        setError(false);
        const d = {};
        for (const e of next.entries || []) d[e.file] = e.keywords;
        setDraft(d);
      };

      // 重拉一次快照：文件可能被面板以外的操作改掉（手动删、别的会话写），
      // 面板不能一直显示已经不在磁盘上的旧卡片。
      const reload = async () => {
        try {
          const res = await fetch('/dsh-memory/status', { cache: 'no-store' });
          if (!res.ok) return;
          applyData(await res.json());
        } catch {
          /* 重拉失败保持现状 */
        }
      };

      React.useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const res = await fetch('/dsh-memory/status', { cache: 'no-store' });
            if (!res.ok) throw new Error(String(res.status));
            const next = await res.json();
            if (alive) applyData(next);
          } catch {
            if (alive) setError(true);
          }
        })();
        return () => {
          alive = false;
        };
      }, []);

      React.useEffect(() => {
        const onFocus = () => reload();
        window.addEventListener('focus', onFocus);
        return () => window.removeEventListener('focus', onFocus);
      }, []);

      // 搜索：去抖 250 ms 打到宿主，由宿主决定命中与片段。
      React.useEffect(() => {
        const q = query.trim();
        if (!q) {
          setSearch(null);
          return undefined;
        }
        let alive = true;
        const timer = setTimeout(async () => {
          try {
            const res = await fetch('/dsh-memory/search', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ q }),
            });
            const body = await res.json();
            if (alive) setSearch(res.ok ? body : null);
          } catch {
            if (alive) setSearch(null);
          }
        }, 250);
        return () => {
          alive = false;
          clearTimeout(timer);
        };
      }, [query]);

      const flash = (file, text) => {
        setNote((prev) => ({ ...prev, [file]: text }));
        setTimeout(() => setNote((prev) => ({ ...prev, [file]: '' })), 1600);
      };

      const post = async (path, payload) => {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || '操作失败');
        // 只有带 entries 的回包才是新快照；别的（例如打开位置）不能拿来整体替换页面状态，
        // 否则 entries 变 undefined，整页卡片会一起消失。
        if (body && Array.isArray(body.entries)) applyData(body);
        return body;
      };

      const saveKeywords = async (file) => {
        try {
          await post('/dsh-memory/keyword', { file, keywords: draft[file] ?? '' });
          setEditing(null);
          flash(file, '已保存');
        } catch (err) {
          flash(file, err.message);
        }
      };

      const toggle = async (entry) => {
        try {
          await post('/dsh-memory/toggle', { file: entry.file, enabled: !entry.enabled });
        } catch (err) {
          flash(entry.file, err.message);
        }
      };

      const protect = async (entry) => {
        try {
          await post('/dsh-memory/protect', { file: entry.file, protected: !entry.protected });
          setEditing(null);
          setReviewing(null);
        } catch (err) {
          flash(entry.file, err.message);
        }
      };

      const resolve = async (file, approve) => {
        try {
          await post(approve ? '/dsh-memory/approve-file' : '/dsh-memory/reject-file', { file });
          setReviewing(null);
        } catch (err) {
          flash(file, err.message);
        }
      };

      const open = async (file) => {
        try {
          await post('/dsh-memory/open', { file });
        } catch (err) {
          flash(file, err.message);
        }
      };

      // 新建：分类拼成首关键词，其余关键词接在后面。
      const submitCreate = async () => {
        const keywords = [form.category, form.extra.trim()].filter(Boolean).join('/');
        try {
          const body = await post('/dsh-memory/create', {
            name: form.name.trim(),
            keywords,
            description: form.description.trim(),
            body: form.body,
          });
          setBanner(`已新建 ${body.created || form.name}`);
          setForm({ name: '', category: '资料', extra: '', description: '', body: '' });
          setCreating(false);
          setTimeout(() => setBanner(''), 2000);
        } catch (err) {
          setBanner(`新建失败：${err.message}`);
        }
      };

      // 删除：点第一下变成「确认删除」，4 秒内再点才真的删。
      const remove = async (entry) => {
        if (confirmDel !== entry.file) {
          setConfirmDel(entry.file);
          setTimeout(() => setConfirmDel((cur) => (cur === entry.file ? null : cur)), 4000);
          return;
        }
        setConfirmDel(null);
        try {
          await post('/dsh-memory/delete', { file: entry.file });
          setBanner(`已删除 ${entry.file}`);
          setTimeout(() => setBanner(''), 2000);
        } catch (err) {
          flash(entry.file, err.message);
        }
      };

      // 沙漏：立刻跑一次压缩判定，跑到宿主那边收工为止（轮询状态）。
      // 运行中的提示只留在沙漏按钮上（显示「压缩中」），不再另外刷一行，避免重复。
      const compressNow = async () => {
        if (compressing) return;
        setCompressing(true);
        try {
          await post('/dsh-memory/compress', {});
          for (let i = 0; i < 160; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 1500));
            const res = await fetch('/dsh-memory/status', { cache: 'no-store' });
            const next = await res.json();
            applyData(next);
            if (!next.compress?.running) {
              setBanner(next.compress?.detail || '压缩结束');
              setTimeout(() => setBanner(''), 3000);
              break;
            }
          }
        } catch (err) {
          setBanner(`压缩失败：${err.message}`);
        } finally {
          setCompressing(false);
        }
      };

      const view = viewOf(data, error);
      const entries = (data && data.entries) || [];
      const proposals = (data && data.proposal && data.proposal.files) || [];
      const proposalFor = (file) => proposals.find((p) => p.file === file);
      const matched = search && search.q ? new Map(search.matches.map((m) => [m.file, m])) : null;
      const visible = entries.filter((e) => !matched || matched.has(e.file));
      const categoryOf = (keywords) => {
        const head = String(keywords || '').split('/')[0].trim();
        return CATEGORIES.includes(head) ? head : '未分类';
      };
      const groups = [];
      // 展示顺序与分类优先级无关：「说明书」放最后，方便把它当资料库翻。
      for (const cat of ['资料', '教训', '项目记忆', '其它', '说明书', '未分类']) {
        const list = visible.filter((e) => categoryOf(e.keywords) === cat);
        if (list.length) groups.push({ cat, list });
      }

      const card = (entry) => {
        const pending = proposalFor(entry.file);
        const isEditing = editing === entry.file;
        const match = matched ? matched.get(entry.file) : null;
        // 待审核的卡片要一眼认出来：左侧一道提醒色竖线 + 顶部「待审」小标。
        const cardStyle = pending
          ? {
              ...(entry.protected ? CARD_LOCKED : CARD),
              borderLeft: '3px solid var(--dsw-alias-state-warn-primary)',
            }
          : entry.protected
            ? CARD_LOCKED
            : CARD;
        return h(
          'div',
          {
            key: entry.file,
            style: cardStyle,
            onDoubleClick: () => {
              if (!entry.protected) setEditing(entry.file);
            },
            title: entry.protected ? '已锁定：不压缩、不改原文和关键词' : '双击修改关键词',
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
            isEditing
              ? h('input', {
                  autoFocus: true,
                  value: draft[entry.file] ?? '',
                  onClick: stop,
                  onDoubleClick: stop,
                  onChange: (ev) => setDraft((prev) => ({ ...prev, [entry.file]: ev.target.value })),
                  onBlur: () => saveKeywords(entry.file),
                  onKeyDown: (ev) => {
                    if (ev.key === 'Enter') saveKeywords(entry.file);
                    if (ev.key === 'Escape') {
                      setDraft((prev) => ({ ...prev, [entry.file]: entry.keywords }));
                      setEditing(null);
                    }
                  },
                  spellCheck: false,
                  style: { ...INPUT, fontSize: 15, fontWeight: 600 },
                  'aria-label': '记忆关键词',
                })
              : h(
                  'span',
                  {
                    style: {
                      fontSize: 16,
                      fontWeight: 600,
                      letterSpacing: '0.2px',
                      color: entry.enabled ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
                    },
                  },
                  highlight(entry.keywords, search && search.q) || '（无关键词）',
                ),
            h(
              'span',
              { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
              entry.protected
                ? h(
                    'span',
                    { title: '已锁定', style: { display: 'inline-flex', color: 'var(--dsw-alias-brand-primary)' } },
                    LOCK_ICON,
                  )
                : null,
              h(
                'span',
                { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
                entry.file,
              ),
              // 索引还在、文件没了：这张卡必须能清掉，不能永远钉在面板上。
              entry.missing
                ? h(
                    'span',
                    {
                      title: '索引里还有这一行，但磁盘上没有对应文件；点右侧垃圾桶清掉这条死行',
                      style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' },
                    },
                    '文件已丢失',
                  )
                : null,
              h(
                'span',
                { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
                entry.recallRate === null || entry.recallRate === undefined ? '回忆率 —' : `回忆率 ${entry.recallRate}%`,
              ),
              entry.pendingDelete
                ? h(
                    'span',
                    { style: { fontSize: 12, color: 'var(--dsw-alias-state-warn-primary)' } },
                    '待删除',
                  )
                : null,
              pending
                ? h(
                    'span',
                    {
                      title: '有一份改稿等你审批',
                      style: {
                        fontSize: 11,
                        lineHeight: '16px',
                        padding: '0 6px',
                        borderRadius: 'var(--dsw-radius-sm)',
                        border: '1px solid var(--dsw-alias-state-warn-primary)',
                        color: 'var(--dsw-alias-state-warn-primary)',
                      },
                    },
                    pending.same ? '待审 · 无改动' : '待审',
                  )
                : null,
            ),
          ),
          // 搜索结果：把命中的原文片段贴回卡片上（带行号 / 字段名）。
          match
            ? h(
                'div',
                {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    padding: '8px 10px',
                    background: 'var(--dsw-alias-bg-base)',
                    border: '1px solid var(--dsw-alias-border-l1)',
                    borderRadius: 'var(--dsw-radius-sm)',
                  },
                },
                match.snippets.slice(0, 4).map((s, i) =>
                  h(
                    'div',
                    { key: `${s.kind}-${i}`, style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                    h('span', { style: COL_HINT }, s.label || ''),
                    h(
                      'span',
                      {
                        style: {
                          fontSize: 12,
                          lineHeight: '18px',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          color: 'var(--dsw-alias-label-primary)',
                        },
                      },
                      highlight(s.text, search && search.q),
                    ),
                  ),
                ),
              )
            : null,
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            entry.protected
              ? null
              : pending
                ? h(
                    'button',
                    {
                      type: 'button',
                      style: {
                        ...BUTTON,
                        ...(reviewing === entry.file
                          ? {
                              borderColor: 'var(--dsw-alias-state-warn-primary)',
                              color: 'var(--dsw-alias-state-warn-primary)',
                            }
                          : {}),
                      },
                      'aria-expanded': reviewing === entry.file,
                      onClick: (ev) => {
                        stop(ev);
                        // 再点一次收起审核面板
                        setReviewing((cur) => (cur === entry.file ? null : entry.file));
                      },
                    },
                    reviewing === entry.file ? '收起' : '审核',
                  )
                : null,
            h('button', { type: 'button', style: BUTTON, onClick: (ev) => { stop(ev); protect(entry); } }, entry.protected ? '已锁定' : '锁定'),
            h('button', { type: 'button', style: BUTTON, onClick: (ev) => { stop(ev); setExpanded(expanded === entry.file ? null : entry.file); } }, '参数'),
            h('button', { type: 'button', style: BUTTON, onClick: (ev) => { stop(ev); open(entry.file); } }, '打开位置'),
            h('span', { style: { marginLeft: 'auto', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, note[entry.file] || ''),
            h(Toggle, { checked: entry.enabled, onChange: () => toggle(entry) }),
            // 一键删除在卡片最右侧；锁定的记忆不给删，得先解锁。
            h(
              'button',
              {
                type: 'button',
                title: entry.protected
                  ? '已锁定：先解锁才能删除'
                  : confirmDel === entry.file
                    ? '再点一次确认删除（4 秒内有效）'
                    : entry.missing
                      ? `文件已不在磁盘上，删除会清掉 ${entry.file} 的索引死行`
                      : `删除 ${entry.file}`,
                style: {
                  ...BUTTON,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '2px 6px',
                  cursor: entry.protected ? 'not-allowed' : 'pointer',
                  opacity: entry.protected ? 0.4 : 1,
                  color: confirmDel === entry.file ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)',
                  borderColor: confirmDel === entry.file ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-border-l1)',
                },
                disabled: Boolean(entry.protected),
                onClick: (ev) => {
                  stop(ev);
                  if (!entry.protected) remove(entry);
                },
              },
              confirmDel === entry.file ? (entry.missing ? '确认清理' : '确认删除') : TRASH_ICON,
            ),
          ),
          expanded === entry.file
            ? h(
                'div',
                {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    paddingTop: 8,
                    borderTop: '1px solid var(--dsw-alias-border-l1)',
                  },
                },
                ((entry.params || []).length
                  ? entry.params
                  : [{ label: '参数', value: '（这份记忆没有 YAML 头）' }]
                ).map((p) =>
                  h(
                    'div',
                    { key: p.label, style: { display: 'flex', gap: 12, alignItems: 'flex-start' } },
                    h('span', { style: { flex: '0 0 auto', width: 56, color: 'var(--dsw-alias-label-secondary)' } }, p.label),
                    h('span', { style: { flex: '1 1 auto', minWidth: 0, wordBreak: 'break-word' } }, p.value),
                  ),
                ),
              )
            : null,
          reviewing === entry.file && pending
            ? (() => {
                const diff = lineDiff(pending.before || '', pending.after || '');
                const same = pending.same === true;
                const pane = (rows) =>
                  h(
                    'div',
                    { style: { ...PRE, padding: 0 } },
                    rows.map((row, i) =>
                      h(
                        'div',
                        {
                          key: `${row.kind}-${i}`,
                          style: {
                            padding: '0 10px',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            ...(row.kind === 'del'
                              ? {
                                  background: '#ffc2c2',
                                  color: '#000',
                                }
                              : {}),
                            ...(row.kind === 'add'
                              ? {
                                  background: '#b4efb4',
                                  color: '#000',
                                }
                              : {}),
                          },
                        },
                        row.text === '' ? '\u00a0' : row.text,
                      ),
                    ),
                  );
                return h(
                  'div',
                  {
                    style: {
                      marginTop: 4,
                      paddingTop: 10,
                      borderTop: '1px solid var(--dsw-alias-border-l1)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                    },
                  },
                  h(
                    'div',
                    { style: { display: 'flex', gap: 12, alignItems: 'flex-start' } },
                    h(
                      'div',
                      { style: COL },
                      h('div', { style: COL_HINT }, `原文 · ${pending.beforeCount ?? 0} 字`),
                      pane(diff.left),
                    ),
                    h(
                      'div',
                      { style: COL },
                      h('div', { style: COL_HINT }, `拟改为 · ${pending.afterCount ?? 0} 字`),
                      pane(diff.right),
                    ),
                  ),
                  same
                    ? h(
                        'div',
                        { style: { fontSize: 12, color: 'var(--dsw-alias-state-warn-primary)' } },
                        '两版正文相同：这份方案没有任何改动，批准等于空转，直接忽略即可。',
                      )
                    : null,
                  h(
                    'div',
                    { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
                    h('button', { type: 'button', style: BUTTON, onClick: (ev) => { stop(ev); resolve(entry.file, false); } }, '忽略'),
                    h(
                      'button',
                      {
                        type: 'button',
                        style: { ...BUTTON, ...(same ? { opacity: 0.5, cursor: 'not-allowed' } : {}) },
                        disabled: same,
                        onClick: (ev) => {
                          stop(ev);
                          if (!same) resolve(entry.file, true);
                        },
                      },
                      '批准',
                    ),
                  ),
                );
              })()
            : null,
        );
      };

      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            font: 'inherit',
            fontSize: 13,
            lineHeight: '20px',
            color: 'var(--dsw-alias-label-primary)',
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h(
            'button',
            { type: 'button', style: BUTTON_STRONG, onClick: () => setCreating((v) => !v) },
            creating ? '收起' : '新建记忆',
          ),
          h('input', {
            value: query,
            placeholder: '搜索关键词或正文…',
            onChange: (ev) => setQuery(ev.target.value),
            spellCheck: false,
            style: { ...INPUT, flex: '0 1 220px', width: 220 },
          }),
          query
            ? h('button', { type: 'button', style: BUTTON, onClick: () => setQuery('') }, '清空')
            : null,
          h('button', { type: 'button', style: BUTTON, onClick: () => reload() }, '刷新'),
          h(
            'button',
            {
              type: 'button',
              title: data?.compress?.interrupted ? '上次压缩中断过，点一下补跑' : '立刻跑一次压缩判定',
              style: {
                ...BUTTON,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                ...(data?.compress?.interrupted
                  ? {
                      borderColor: 'var(--dsw-alias-state-warn-primary)',
                      color: 'var(--dsw-alias-state-warn-primary)',
                    }
                  : {}),
              },
              disabled: compressing || Boolean(data?.compress?.running),
              onClick: compressNow,
            },
            HOURGLASS_ICON,
            compressing || data?.compress?.running ? '压缩中' : '',
          ),
          h('span', { style: { marginLeft: 'auto', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, banner),
        ),
        // 记忆状态：输入框那条的备份显示，照常随下一次人类发言消失。
        rememberState.status !== 'idle' && rememberState.text
          ? h(
              'div',
              {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  color:
                    rememberState.status === 'error'
                      ? 'var(--dsw-alias-state-error-primary)'
                      : 'var(--dsw-alias-label-secondary)',
                },
              },
              h(
                'span',
                {
                  style: {
                    display: 'inline-flex',
                    color:
                      rememberState.status === 'error'
                        ? 'var(--dsw-alias-state-error-primary)'
                        : 'var(--dsw-alias-brand-primary)',
                  },
                },
                BRAIN_ICON,
              ),
              h('span', null, rememberState.text),
            )
          : null,
        data?.compress?.interrupted
          ? h(
              'div',
              {
                style: {
                  padding: '8px 12px',
                  border: '1px solid var(--dsw-alias-state-warn-primary)',
                  borderRadius: 'var(--dsw-radius-sm)',
                  color: 'var(--dsw-alias-state-warn-primary)',
                  fontSize: 12,
                },
              },
              `上次压缩中断（${String(data.compress.startedAt).slice(0, 16).replace('T', ' ')} 起，${data.compress.stage || '未知阶段'}）——点沙漏补跑。`,
            )
          : null,
        data?.compress?.failed && !data?.compress?.running
          ? h(
              'div',
              {
                style: {
                  padding: '8px 12px',
                  border: '1px solid var(--dsw-alias-state-error-primary)',
                  borderRadius: 'var(--dsw-radius-sm)',
                  color: 'var(--dsw-alias-state-error-primary)',
                  fontSize: 12,
                },
              },
              `上次压缩失败（${String(data.compress.finishedAt || '').slice(5, 16).replace('T', ' ')}）：${data.compress.detail || '未知原因'}——点沙漏重跑。`,
            )
          : null,
        creating
          ? h(
              'div',
              { style: { ...CARD, gap: 8 } },
              h(
                'div',
                { style: FORM_ROW },
                h('span', { style: FORM_LABEL }, '名称'),
                h('input', {
                  value: form.name,
                  placeholder: 'english-name（小写字母、数字、连字符）',
                  onChange: (ev) => setForm((f) => ({ ...f, name: ev.target.value })),
                  spellCheck: false,
                  style: { ...INPUT, maxWidth: 320 },
                }),
              ),
              h(
                'div',
                { style: FORM_ROW },
                h('span', { style: FORM_LABEL }, '分类'),
                h(CategoryPicker, {
                  value: form.category,
                  onChange: (c) => setForm((f) => ({ ...f, category: c })),
                }),
                h('span', { style: { ...FORM_LABEL, width: 'auto' } }, '其余关键词'),
                h('input', {
                  value: form.extra,
                  placeholder: '用 / 分隔，如 项目名/工具名',
                  onChange: (ev) => setForm((f) => ({ ...f, extra: ev.target.value })),
                  spellCheck: false,
                  style: { ...INPUT, maxWidth: 360 },
                }),
              ),
              h(
                'div',
                { style: FORM_ROW },
                h('span', { style: FORM_LABEL }, '描述'),
                h('input', {
                  value: form.description,
                  placeholder: '一句话说清这是什么、什么时候该读',
                  onChange: (ev) => setForm((f) => ({ ...f, description: ev.target.value })),
                  style: INPUT,
                }),
              ),
              h('textarea', {
                value: form.body,
                placeholder: '正文（Markdown，2000 字以内通常够用，写清楚比写短重要）',
                onChange: (ev) => setForm((f) => ({ ...f, body: ev.target.value })),
                rows: 6,
                style: { ...INPUT, resize: 'vertical', minHeight: 96 },
              }),
              h(
                'div',
                { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
                h(
                  'button',
                  {
                    type: 'button',
                    style: BUTTON,
                    onClick: () => {
                      setCreating(false);
                      setBanner('');
                    },
                  },
                  '取消',
                ),
                h('button', { type: 'button', style: BUTTON, onClick: submitCreate }, '保存'),
              ),
            )
          : null,
        groups.length
          ? groups.map((group) => {
              const isCollapsed = Boolean(collapsed[group.cat]) && !matched;
              return h(
                'div',
                { key: group.cat, style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                h(
                  'div',
                  {
                    role: 'button',
                    tabIndex: 0,
                    onClick: () => setCollapsed((prev) => ({ ...prev, [group.cat]: !prev[group.cat] })),
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '2px 2px',
                      cursor: 'pointer',
                      fontSize: 12,
                      color: 'var(--dsw-alias-label-secondary)',
                      userSelect: 'none',
                    },
                  },
                  h(
                    'span',
                    {
                      style: {
                        display: 'inline-flex',
                        transform: isCollapsed ? 'rotate(-90deg)' : 'none',
                        transition: 'transform .15s',
                      },
                    },
                    CHEVRON_ICON,
                  ),
                  h('span', null, `${group.cat} · ${group.list.length}`),
                ),
                isCollapsed ? null : group.list.map(card),
              );
            })
          : h(
              'div',
              { style: { color: 'var(--dsw-alias-label-secondary)' } },
              matched ? '没有匹配的记忆。' : '还没有记忆条目。',
            ),
        h(
          'div',
          { style: { ...CARD, gap: 0, marginTop: 4 } },
          h(
            StatusRow,
            { label: '状态' },
            h(
              'span',
              { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
              h('span', { style: dot(TONE[view.tone]) }),
              h('span', null, view.label),
            ),
          ),
          h(StatusRow, { label: '上次运行' }, formatTime(data && data.lastRun)),
          h(StatusRow, { label: '待审批方案' }, data && data.count > 0 ? `${data.count} 份` : '无'),
          h(StatusRow, { label: '记忆文件' }, data ? `${data.files} 个 · ${formatBytes(data.bytes)}` : '—'),
          h(StatusRow, { label: '自动化 API', last: true }, data ? (data.keyConfigured ? '已配置' : '未配置') : '—'),
        ),
        h(
          'div',
          { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all' } },
          data && data.outline ? data.outline : '（当前没有披露给模型的记忆）',
        ),
      );
    }

    return {
      inject: ['slots', 'commandUi'],
      apply(ctx) {
        try {
          fetch('/dsh-memory/status?client=1', { cache: 'no-store' }).catch(() => {});
        } catch {
          /* 心跳失败不影响注册 */
        }
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            // 设置页导航的图标是外壳按 id 写死的，未知 id 一律用齿轮，会和「通用设置」撞车；
            // archived-sessions 是外壳映射里唯一没被占用的 id，借它的归档图标显示「记忆管理」。
            { name: 'settings.section', id: 'archived-sessions', order: 12, label: '记忆管理' },
            MemorySettings,
          ),
        );
        // /remember：客户端 action，带大脑图标进斜杠列表；不落命令行、不写会话历史。
        ctx.effect(
          () =>
            ctx.commandUi.register({
              name: 'remember',
              label: () => '记住本对话',
              description: () => '把这段对话记成一条项目记忆',
              icon: BrainGlyph,
              available: () => true,
              ui: {
                kind: 'action',
                run: (session) => {
                  runRemember(session);
                },
              },
            }),
          'memory /remember action',
        );
        // 状态条挂在输入框卡片底部的控件行（conversation.input.right）：
        // 这个槽位是外壳实打实渲染的（/context 的百分比就在那儿），不再赌 composer.dock。
        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register(
            { name: 'conversation.input.right', id: 'memory-remember-status', order: 20 },
            RememberStatusRow,
          ),
        );
        // 「记忆」标签页：和 对话 / 轨迹 并列，按会话列出记忆调用（单行 + 粉色标签）。
        // 注册失败不能连累设置页和状态条，所以整体兜一层 try。
        ctx.slots.inject('conversation.view', () => {
          try {
            return ctx.slots.register(
              {
                name: 'conversation.view',
                id: 'memory-calls',
                order: 20,
                label: () => '记忆',
                inject: (sessionId) => ({ memorySessionId: sessionId }),
              },
              MemoryCallsView,
            );
          } catch (err) {
            console.warn('[dsh-memory] 记忆视图注册失败', err);
            return () => {};
          }
        });
      },
    };
  },
});
