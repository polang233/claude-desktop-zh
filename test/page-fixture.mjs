export function pageFixture(buttons = []) {
  const element = (properties = {}) => ({ textContent: '', disabled: true, children: [], attributes: {}, events: {},
    append(...children) { this.children.push(...children); },
    addEventListener(event, callback) { this.events[event] = callback; if (event === 'click') this.click = callback; },
    setAttribute(key, value) { this.attributes[key] = value; }, removeAttribute(key) { delete this.attributes[key]; },
    toggleAttribute(key, value) { if (value) this.attributes[key] = ''; else delete this.attributes[key]; },
    focus() { this.events.focus?.(); }, ...properties });
  const elements = new Map(['status','log','locale','locale-select','runtime-auto','auto-state','save','preferences-form','paths','mode','guard'].map(id => [id, element()]));
  const tabs = [element(), element()], panels = [element(), element()], group = element();
  return { elements, tabs, panels, element,
    document: { getElementById: id => elements.get(id), createElement: () => element(), querySelector: () => group,
      querySelectorAll: selector => selector === '[role="tab"]' ? tabs : selector === '[role="tabpanel"]' ? panels : buttons },
    HTMLElement: function () {} };
}
