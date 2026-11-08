// First import: it moves UI preferences saved under Newbro's localStorage
// keys to Vimperium's before anything below can read them.
import './lib/legacy-storage'
import ReactDOM from 'react-dom/client'
import App from './App'
import './globals.css'

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
