"use client";
import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('UI ErrorBoundary caught', error, info);
  }
  handleReset = () => {
    if (this.props.onReset) this.props.onReset();
    this.setState({ error: null });
  };
  render() {
    if (this.state.error) {
      return (
        <div style={{padding:'2rem',fontFamily:'system-ui,sans-serif'}}>
          <h2 style={{marginTop:0,color:'#ff6a69'}}>Something went wrong.</h2>
          <pre style={{whiteSpace:'pre-wrap',background:'#161b22',padding:'1rem',border:'1px solid #30363d',borderRadius:6,maxHeight:200,overflow:'auto'}}>{String(this.state.error?.message || this.state.error)}</pre>
          <div style={{display:'flex',gap:'0.5rem',marginTop:'1rem'}}>
            <button onClick={this.handleReset} style={{background:'#238636',color:'#fff',border:'1px solid #2ea043',padding:'0.6rem 1rem',borderRadius:6,cursor:'pointer'}}>Reset Boundary</button>
            <button onClick={()=>window.location.reload()} style={{background:'#30363d',color:'#fff',border:'1px solid #484f58',padding:'0.6rem 1rem',borderRadius:6,cursor:'pointer'}}>Reload Page</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
