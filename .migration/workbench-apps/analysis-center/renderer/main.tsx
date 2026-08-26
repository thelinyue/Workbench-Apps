import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AnalysisCenterApp } from './view';
import './style.css';

createRoot(document.getElementById('root')!).render(<StrictMode><AnalysisCenterApp /></StrictMode>);
