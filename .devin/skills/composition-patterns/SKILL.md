---
name: composition-patterns
description: React component composition rules for structuring components without boolean prop proliferation. Covers compound components, context providers, state lifting, and React 19 API changes.
when_to_use: "When refactoring components with too many boolean props, designing compound components (Select, Accordion, Tabs), or migrating forwardRef to React 19 ref props. NOT for styling or layout decisions."
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
effort: medium
---

# React Composition Patterns

> Keep component APIs clean as codebases grow. Replace boolean props with composable children.

---

## Core Philosophy

**Boolean props are a code smell.** When a component accumulates 5+ boolean flags (`isOpen`, `isDisabled`, `isLoading`, `isCompact`, `hasFooter`), its API has rotted. Composition keeps APIs open for extension without modification.

---

## 1. Compound Components

Split a monolithic component into a family of related sub-components.

### Before (Boolean Prop Hell)

```tsx
// 6 boolean props, impossible to extend cleanly
<Dropdown
  isOpen={open}
  isDisabled={disabled}
  hasSearch={true}
  renderHeader={<CustomHeader />}
  renderFooter={<CustomFooter />}
/>
```

### After (Composition)

```tsx
<Dropdown>
  <Dropdown.Trigger>Open</Dropdown.Trigger>
  <Dropdown.Menu>
    <Dropdown.Item>One</Dropdown.Item>
    <Dropdown.Item>Two</Dropdown.Item>
  </Dropdown.Menu>
</Dropdown>
```

### Implementation

```tsx
const DropdownContext = createContext(null)

function Dropdown({ children }) {
  const [open, setOpen] = useState(false)
  return (
    <DropdownContext.Provider value={{ open, setOpen }}>
      <div className="dropdown">{children}</div>
    </DropdownContext.Provider>
  )
}

Dropdown.Trigger = function Trigger({ children }) {
  const { setOpen } = useContext(DropdownContext)
  return <button onClick={() => setOpen(o => !o)}>{children}</button>
}

Dropdown.Menu = function Menu({ children }) {
  const { open } = useContext(DropdownContext)
  return open ? <div className="menu">{children}</div> : null
}
```

---

## 2. Replace render* Props with Children

`renderHeader` and `renderFooter` props create rigid APIs. Use `children` or named slots instead.

### Before

```tsx
<Card
  renderHeader={<Title />}
  renderBody={<Content />}
  renderFooter={<Actions />}
/>
```

### After

```tsx
<Card>
  <Card.Header><Title /></Card.Header>
  <Card.Body><Content /></Card.Body>
  <Card.Footer><Actions /></Card.Footer>
</Card>
```

---

## 3. State Lifting Over Context

Before reaching for Context, ask: can the state live in a parent component and be passed as props?

```tsx
// Prefer lifting state before Context
function Parent() {
  const [activeTab, setActiveTab] = useState('a')
  return (
    <Tabs activeTab={activeTab} onChange={setActiveTab}>
      <Tab id="a">Tab A</Tab>
      <Tab id="b">Tab B</Tab>
    </Tabs>
  )
}
```

**Rule of thumb:** Context is for shared state that changes rarely. Props are for component-specific state.

---

## 4. React 19 Ref Changes

React 19 removes `forwardRef`. Pass `ref` as a normal prop.

### Before (React 18)

```tsx
const Input = forwardRef((props, ref) => (
  <input ref={ref} {...props} />
))
```

### After (React 19)

```tsx
function Input({ ref, ...props }) {
  return <input ref={ref} {...props} />
}
```

---

## 5. Avoid Prop Spreading as API

```tsx
// Bad: Accepts anything, hides the real API
<MagicComponent {...anyProps} />

// Good: Explicit props with composition for extensibility
<ExplicitComponent title="Hello">
  <CustomContent />
</ExplicitComponent>
```

---

## Anti-Patterns Checklist

- [ ] No component has 5+ boolean props
- [ ] No `renderX` props (use composition instead)
- [ ] Context is used for truly shared state, not prop drilling avoidance
- [ ] `forwardRef` migrated to React 19 ref-as-prop
- [ ] Compound components used for complex UI widgets (Select, Tabs, Accordion, Modal)

---

## Decision Tree

```
Component growing too many props?
  → Can it be split into compound components? → YES → Use composition
  → Is state shared across distant components? → YES → Use Context
  → Is it just prop drilling? → YES → Lift state or use composition
```
