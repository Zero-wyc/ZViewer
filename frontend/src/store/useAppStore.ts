import { create } from 'zustand'

interface AppState {
  username: string
  setUsername: (name: string) => void
}

export const useAppStore = create<AppState>((set) => ({
  username: '',
  setUsername: (name) => set({ username: name }),
}))
