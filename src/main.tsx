import React from 'react';
import ReactDOM from 'react-dom/client';
import AuthShell from './AuthShell';
import './style.css';
import ConnectionNotice from './pwa';
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><ConnectionNotice /><AuthShell /></React.StrictMode>);

const viewport = window.visualViewport;
const resizeViewport = () => document.documentElement.style.setProperty('--visual-height', (viewport?.height ?? window.innerHeight) + 'px');
resizeViewport(); viewport?.addEventListener('resize', resizeViewport);
