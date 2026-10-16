import React from 'react';
import type { SidebarStyle } from '../../../sidebarStyle';

const Bar = ({ w = 'w2', strong }: { w?: string; strong?: boolean }) => <span className={`st-pv-bar ${w}${strong ? ' strong' : ''}`} />;
const Row = ({ dot, sel }: { dot: string; sel?: boolean }) => (
  <div className="st-pv-row" data-sel={sel || undefined}><span className={`st-pv-dot ${dot}`} /><Bar /></div>
);

function Aside() {
  return (
    <>
      <div className="st-pv-brand"><span className="st-pv-mark" /><Bar w="w4" strong /></div>
      <div className="st-pv-composer"><Bar /><span className="st-pv-pill">New</span></div>
      <div className="st-pv-chips">
        <span className="st-pv-chip" data-on><i className="st-pv-dot needs" />2</span>
        <span className="st-pv-chip"><i className="st-pv-dot work" />3</span>
        <span className="st-pv-chip"><i className="st-pv-dot" />5</span>
      </div>
      <div className="st-pv-group">Needs you</div>
      <Row dot="needs" sel />
      <Row dot="work" />
      <div className="st-pv-strip"><i className="a" /><i /><i /></div>
    </>
  );
}

function Claude() {
  return (
    <>
      <div className="st-pv-composer"><span className="st-pv-prompt">❯</span><Bar /></div>
      <div className="st-pv-group"><i className="st-pv-dot needs" />Needs you</div>
      <Row dot="needs" sel />
      <div className="st-pv-group"><i className="st-pv-dot work" />Working</div>
      <Row dot="work" />
      <Row dot="work" />
    </>
  );
}

function Mission() {
  return (
    <>
      <div className="st-pv-stats">
        <span className="st-pv-stat" data-on><b style={{ color: 'var(--fm-needs)' }}>2</b><span>Needs</span></span>
        <span className="st-pv-stat"><b style={{ color: 'var(--fm-ok)' }}>1</b><span>Review</span></span>
        <span className="st-pv-stat"><b style={{ color: 'var(--fm-accent)' }}>3</b><span>Working</span></span>
        <span className="st-pv-stat"><b>5</b><span>Idle</span></span>
      </div>
      <div className="st-pv-queue"><em>Attention</em><Bar w="w3" /></div>
      <div className="st-pv-card"><Bar w="w3" strong /><Bar /><Bar w="w1" /></div>
      <div className="st-pv-card"><Bar w="w2" strong /><Bar /><Bar w="w1" /></div>
    </>
  );
}

const PREVIEW: Record<SidebarStyle, () => React.ReactElement> = { aside: Aside, claude: Claude, mission: Mission };

/** A miniature of the sidebar in this style, drawn with the style's own palette variables. */
export function StylePreview({ id }: { id: SidebarStyle }) {
  const Body = PREVIEW[id];
  return <div className={`st-pv fm-${id}`} aria-hidden="true"><Body /></div>;
}
