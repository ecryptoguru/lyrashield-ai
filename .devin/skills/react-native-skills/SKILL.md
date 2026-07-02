---
name: react-native-skills
description: Best practices for React Native and Expo apps. Covers list performance, animations, navigation, UI patterns, and monorepo configuration. References FlashList, Reanimated, and Expo Image.
when_to_use: "When building React Native or Expo apps, optimizing lists, configuring animations, setting up navigation, or structuring monorepos. NOT for web apps or mobile web views."
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
effort: medium
---

# React Native Best Practices

> Prioritized rules for building fast, reliable React Native and Expo applications.

---

## 1. List Performance (CRITICAL)

### Use FlashList Instead of FlatList

`FlatList` recycles views poorly on large datasets. Use `@shopify/flash-list`:

```tsx
import { FlashList } from '@shopify/flash-list'

<FlashList
  data={items}
  renderItem={({ item }) => <ItemRow item={item} />}
  estimatedItemSize={80}
/>
```

**Why:** FlashList reuses off-screen cells aggressively, cutting memory by 50%+.

### Key Rules for Lists

- Always provide `estimatedItemSize`
- Avoid inline functions in `renderItem` — memoize
- Use `getItemLayout` only with fixed-height items
- Never put a `ScrollView` inside a list item

---

## 2. Animations (HIGH)

### Use Reanimated for Smooth Animations

```tsx
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring
} from 'react-native-reanimated'

function Box() {
  const offset = useSharedValue(0)

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: offset.value }]
  }))

  return (
    <Animated.View style={animatedStyle}>
      <Button title="Move" onPress={() => { offset.value = withSpring(100) }} />
    </Animated.View>
  )
}
```

**Why:** Runs on UI thread, bypasses JS bridge latency.

### GPU-Compatible Properties Only

✅ `transform`, `opacity` — GPU-accelerated
❌ `width`, `height`, `top`, `left` — Triggers layout, drops frames

---

## 3. Navigation (HIGH)

### Prefer Native Stack Over JS Stack

```tsx
import { createNativeStackNavigator } from '@react-navigation/native-stack'

const Stack = createNativeStackNavigator()

<Stack.Navigator>
  <Stack.Screen name="Home" component={HomeScreen} />
</Stack.Navigator>
```

**Why:** Native navigation uses platform transitions, 60fps guaranteed.

### Avoid Navigation in Render

```tsx
// Bad: Triggers re-render on every navigation
function Header() {
  const navigation = useNavigation()
  return <Button onPress={() => navigation.navigate('Profile')} />
}

// Good: Stable reference
function Header() {
  const navigation = useNavigation()
  const goToProfile = useCallback(() => navigation.navigate('Profile'), [navigation])
  return <Button onPress={goToProfile} />
}
```

---

## 4. Images (MEDIUM-HIGH)

### Use Expo Image

```tsx
import { Image } from 'expo-image'

<Image
  source={{ uri: 'https://example.com/photo.jpg' }}
  contentFit="cover"
  transition={200}
  cachePolicy="memory-disk"
/>
```

**Advantages over react-native `Image`:**
- WebP/AVIF support
- Better caching
- Cross-platform blurhash

### Preload Critical Images

```tsx
import { Image } from 'expo-image'

Image.prefetch(['https://example.com/hero.jpg'])
```

---

## 5. Monorepo Configuration (MEDIUM)

### Keep Native Dependencies in the App Package

```
apps/
  mobile/
    package.json   <-- native deps here (react-native, expo)
    ios/
    android/
packages/
  ui/              <-- shared components, NO native deps
  shared/          <-- shared logic, NO native deps
```

**Rule:** `react-native-*` and `expo-*` packages must live in the app package, not shared packages.

### Configure Metro for Monorepos

```js
// metro.config.js
const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')

const config = getDefaultConfig(__dirname)
config.watchFolders = [path.resolve(__dirname, '../../')]
module.exports = config
```

---

## 6. UI Patterns (MEDIUM)

### Platform-Specific Files

```tsx
// Button.ios.tsx
// Button.android.tsx
// Button.tsx (fallback)

import { Button } from './Button' // Auto-resolves by platform
```

### Avoid TouchableOpacity for Everything

| Component | When to Use |
|-----------|-------------|
| `Pressable` | Default — most flexible |
| `TouchableOpacity` | Simple opacity feedback |
| `TouchableHighlight` | Highlight feedback |

---

## 7. Fonts & Assets (LOW-MEDIUM)

### Use Expo Config Plugins for Custom Fonts

```json
// app.json
{
  "plugins": [
    [
      "expo-font",
      {
        "fonts": ["./assets/fonts/Inter-Regular.ttf"]
      }
    ]
  ]
}
```

No manual linking needed. Run `npx expo prebuild` to apply.

---

## Performance Review Checklist

- [ ] FlashList used for lists > 20 items
- [ ] Reanimated used for complex animations
- [ ] Only `transform`/`opacity` animated
- [ ] Native stack navigator used
- [ ] Expo Image used over RN Image
- [ ] Critical images preloaded
- [ ] Native deps in app package (monorepo)
- [ ] `estimatedItemSize` provided to FlashList
- [ ] No `ScrollView` inside list items
- [ ] Config plugin used for fonts (Expo)
