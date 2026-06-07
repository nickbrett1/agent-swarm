import http from 'http';

export default class SharedRunnerReporter {
  constructor() {
    this.status = 'idle';
    this.results = null;
    this.ctx = null;
    this.server = null;
  }

  onInit(vitest) {
    this.ctx = vitest;
    
    // Only start the server once
    if (this.server) return;

    this.server = http.createServer(async (req, res) => {
      // Set CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Content-Type', 'application/json');

      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }

      if (req.url === '/status') {
        res.statusCode = 200;
        res.end(JSON.stringify({ status: this.status, results: this.results }));
      } else if (req.url === '/run' && req.method === 'POST') {
        res.statusCode = 200;
        res.end(JSON.stringify({ status: 'triggered' }));
        
        // Trigger a Vitest run programmatically
        try {
          // In Vitest, start() runs the tests
          await this.ctx.start();
        } catch (err) {
          console.error('[SharedRunnerReporter] Error triggering test run:', err);
        }
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Not Found' }));
      }
    });

    // Handle port in use gracefully
    this.server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.warn('[SharedRunnerReporter] Port 51204 is already in use. Shared runner API not started.');
      } else {
        console.error('[SharedRunnerReporter] Server error:', err);
      }
    });

    this.server.listen(51204, '127.0.0.1', () => {
      console.log('[SharedRunnerReporter] Shared test runner API listening on http://127.0.0.1:51204');
    });

    // Don't block process exit when the user terminates Vitest
    this.server.unref();
  }

  onTestRunStart() {
    this.status = 'running';
  }

  onFinished(files, errors) {
    // Determine overall success/failure
    const hasErrors = (errors && errors.length > 0) || 
                      (files && files.some(f => f.result?.state === 'fail' || (f.tasks && f.tasks.some(t => t.result?.state === 'fail'))));

    this.status = hasErrors ? 'failed' : 'passed';

    // Count passed, failed, and total tests
    let passed = 0;
    let failed = 0;
    let total = 0;

    const countTasks = (tasks) => {
      for (const task of tasks || []) {
        if (task.type === 'test') {
          total++;
          if (task.result?.state === 'pass') passed++;
          else if (task.result?.state === 'fail') failed++;
        } else if (task.type === 'suite') {
          countTasks(task.tasks);
        }
      }
    };

    for (const file of files || []) {
      countTasks(file.tasks);
    }

    this.results = {
      passed,
      failed,
      total,
      time: new Date().toISOString(),
      errors: errors?.map(e => e.message || e.toString()) || []
    };
  }
}
