declare const __COMPOSITION_ID__: string
declare const __COMPOSITION_WIDTH__: number
declare const __COMPOSITION_HEIGHT__: number

interface Window {
  __timelines: Record<string, GSAPTimeline>
}
