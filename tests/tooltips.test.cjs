const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8');

function tooltipApp() {
    class Element {
        constructor(tagName = 'div') {
            this.tagName = tagName.toUpperCase();
            this.dataset = {};
            this.attributes = new Map();
            this.children = [];
            this.style = {};
            this.textContent = '';
            this.innerHTML = '';
            this.isConnected = false;
            this.rect = { left: 20, top: 30, right: 100, bottom: 54, width: 80, height: 24 };
            const classes = new Set();
            this.classList = { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) };
        }
        setAttribute(name, value) { this.attributes.set(name, value); }
        getAttribute(name) { return this.attributes.get(name) ?? null; }
        hasAttribute(name) { return this.attributes.has(name); }
        removeAttribute(name) { this.attributes.delete(name); }
        appendChild(child) { this.children.push(child); child.parentElement = this; child.isConnected = true; return child; }
        contains(element) { return Boolean(element && (element === this || this.children.some(child => child.contains(element)))); }
        closest() { return this.dataset.tooltip !== undefined ? this : this.parentElement?.closest() || null; }
        getBoundingClientRect() { return this.rect; }
    }
    const documentEvents = new Map();
    const windowEvents = new Map();
    const timers = new Map();
    let nextTimer = 0;
    const listen = events => (name, handler) => events.set(name, [...(events.get(name) || []), handler]);
    const document = {
        body: new Element('body'),
        documentElement: { clientWidth: 640, clientHeight: 480 },
        addEventListener: listen(documentEvents),
        createElement: tag => new Element(tag),
    };
    const context = vm.createContext({
        document, console,
        localStorage: { getItem: () => null },
        setTimeout(handler, delay) { timers.set(++nextTimer, { handler, delay }); return nextTimer; },
        clearTimeout(id) { timers.delete(id); },
    });
    context.window = context;
    context.addEventListener = listen(windowEvents);
    vm.runInContext(source, context);
    vm.runInContext('initTooltips()', context);
    const popup = document.body.children[0];
    function target(text, tag = 'button') {
        const element = document.body.appendChild(new Element(tag));
        context.element = element;
        context.tooltipText = text;
        vm.runInContext('setTooltip(element, tooltipText)', context);
        return element;
    }
    return {
        context, popup, target, timers,
        documentEvent(name, event = {}) { for (const listener of documentEvents.get(name) || []) listener(event); },
        windowEvent(name, event = {}) { for (const listener of windowEvents.get(name) || []) listener(event); },
        runTimers() { const pending = [...timers.values()]; timers.clear(); pending.forEach(timer => timer.handler()); },
    };
}

test('delegated tooltips delay, render untrusted content as text, and preserve existing descriptions', () => {
    const app = tooltipApp();
    const text = '<img src=x onerror=alert(1)> "name"';
    const target = app.target(text);
    target.setAttribute('title', 'old native tooltip');
    target.setAttribute('aria-describedby', 'existing-note');
    vm.runInContext('setTooltip(element, tooltipText)', app.context);
    assert.equal(target.hasAttribute('title'), false);
    assert.equal(target.getAttribute('aria-label'), text);
    app.documentEvent('pointerover', { target, pointerType: 'mouse' });
    assert.equal(app.popup.classList.contains('is-visible'), false);
    assert.equal([...app.timers.values()][0].delay, 300);
    app.runTimers();
    assert.equal(app.popup.textContent, text);
    assert.equal(app.popup.innerHTML, '');
    assert.equal(app.popup.getAttribute('role'), 'tooltip');
    assert.equal(app.popup.getAttribute('aria-hidden'), 'false');
    assert.equal(target.getAttribute('aria-describedby'), 'existing-note appTooltip');
    app.documentEvent('pointerout', { target, relatedTarget: null });
    assert.equal(target.getAttribute('aria-describedby'), 'existing-note');
    assert.equal(app.popup.getAttribute('aria-hidden'), 'true');
});

test('keyboard focus shows tooltips, while touch focus does not', () => {
    const app = tooltipApp();
    const target = app.target('刷新文件树');
    app.documentEvent('pointerdown', { target, pointerType: 'touch' });
    app.documentEvent('pointerover', { target, pointerType: 'touch' });
    app.documentEvent('focusin', { target });
    app.runTimers();
    assert.equal(app.popup.classList.contains('is-visible'), false);
    app.documentEvent('keydown', { key: 'Tab' });
    app.documentEvent('focusin', { target });
    app.runTimers();
    assert.equal(app.popup.classList.contains('is-visible'), true);
    app.documentEvent('focusout', { target, relatedTarget: null });
    assert.equal(target.hasAttribute('aria-describedby'), false);
});

test('pointerdown, scrolling, resizing, Escape, and context menus dismiss tooltips', () => {
    const app = tooltipApp();
    const target = app.target('下载所选文件');
    const dismissals = [
        () => app.documentEvent('pointerdown', { pointerType: 'mouse' }),
        () => app.documentEvent('scroll'),
        () => app.windowEvent('resize'),
        () => app.documentEvent('keydown', { key: 'Escape' }),
        () => app.documentEvent('contextmenu'),
    ];
    for (const dismiss of dismissals) {
        app.documentEvent('pointerover', { target, pointerType: 'mouse' });
        app.runTimers();
        assert.equal(app.popup.classList.contains('is-visible'), true);
        dismiss();
        assert.equal(app.popup.classList.contains('is-visible'), false);
        assert.equal(target.hasAttribute('aria-describedby'), false);
    }
});

test('leaving a pending target cancels display and detached targets never acquire descriptions', () => {
    const app = tooltipApp();
    const target = app.target('/folder/file.mp4', 'span');
    app.documentEvent('pointerover', { target, pointerType: 'mouse' });
    app.documentEvent('pointerout', { target, relatedTarget: null });
    app.runTimers();
    assert.equal(app.popup.classList.contains('is-visible'), false);
    app.documentEvent('pointerover', { target, pointerType: 'mouse' });
    target.isConnected = false;
    app.runTimers();
    assert.equal(target.hasAttribute('aria-describedby'), false);
    assert.equal(app.popup.classList.contains('is-visible'), false);
});
