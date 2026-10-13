import { resolve } from 'node:path'

export default defineConfig({
  include: ['tests/**/*.spec.ts'],
  alias: {
    '@dsh-cc/vwa-evidence': resolve(__dirname, 'src/index.ts'),
  },
})
