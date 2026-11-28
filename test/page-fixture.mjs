export function pageFixture(buttons = []) {
  const element = (properties = {}) => ({ textContent: '', disabled: true, children: [], attributes: {}, events: {},
    append(...children) { this.children.push(...children); }, remove() {},
    addEventListener(event, callback) { this.events[event] = callback; if (event === 'click') this.click = callback; },
    setAttribute(key, value) { this.attributes[key] = value; }, removeAttribute(key) { delete this.attributes[key]; },
    getAttribute(key) { return this.attributes[key] ?? null; },
    toggleAttribute(key, value) { if (value) this.attributes[key] = ''; else delete this.attributes[key]; },
    showModal() { this.open = true; }, close(value) { this.open = false; this.returnValue = value; this.events.close?.(); },
    focus() { this.events.focus?.(); }, ...properties });
  const elements = new Map(['status','log','locale','locale-select','runtime-auto','auto-state','save','preferences-form','paths','mode','guard','refresh-maintenance','runtime-status','resource-status','patch-status','plugin-version','repository-link','author-link','project-link-status','method','method-row','method-note','auto-row','resource-actions','third-party-actions','live-stage','confirm-action','confirm-title','confirm-details','confirm-cancel','confirm-accept','retry-connection'].map(id => [id, element()]));
  const tabs = [element(), element()], panels = [element(), element()], group = element();
  return { elements, tabs, panels, element,
    document: { getElementById: id => elements.get(id), createElement: () => element(), querySelector: () => group,
      querySelectorAll: selector => selector === '[role="tab"]' ? tabs : selector === '[role="tabpanel"]' ? panels : buttons },
    HTMLElement: function () {} };
}
