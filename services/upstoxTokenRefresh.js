const { spawn } = require('child_process');
const AccessToken = require('../models/AccessToken');

class UpstoxTokenRefresh {
  async refreshToken() {
    const startTime = Date.now();
    
    return new Promise((resolve) => {
      try {
        console.log('\n╔════════════════════════════════════════════════╗');
        console.log('║   🔄 UPSTOX TOKEN REFRESH STARTED             ║');
        console.log('╚════════════════════════════════════════════════╝\n');
        console.log(`[Token Refresh] Time: ${new Date().toISOString()}`);
        console.log('[Token Refresh] Running Python script...\n');
        
        const pythonProcess = spawn('python', ['python-scripts/refresh_upstox_token.py'], {
          env: process.env,
          cwd: process.cwd()
        });
        
        let output = '';
        let errorOutput = '';
        
        pythonProcess.stdout.on('data', (data) => {
          const text = data.toString();
          output += text;
          text.split('\n').filter(line => line.trim()).forEach(line => {
            console.log('[Python] ' + line);
          });
        });
        
        pythonProcess.stderr.on('data', (data) => {
          const text = data.toString();
          errorOutput += text;
          console.error('[Python Error] ' + text);
        });
        
        pythonProcess.on('close', async (code) => {
          const duration = ((Date.now() - startTime) / 1000).toFixed(2);
          
          if (code === 0) {
            console.log('\n[Token Refresh] ✓ Python script completed successfully');
            
            try {
              const tokenDoc = await AccessToken.findOne();
              
              if (tokenDoc && tokenDoc.token) {
                console.log('[Token Refresh] ✓ Token verified in MongoDB');
                console.log(`[Token Refresh] User: ${tokenDoc.user_name || 'N/A'}`);
                console.log(`[Token Refresh] Expires: ${tokenDoc.expires_at}`);
                console.log(`[Token Refresh] Duration: ${duration}s`);
                
                console.log('\n╔════════════════════════════════════════════════╗');
                console.log('║   ✅ TOKEN REFRESH SUCCESSFUL                  ║');
                console.log('╚════════════════════════════════════════════════╝\n');
                
                resolve({
                  success: true,
                  expiresAt: tokenDoc.expires_at,
                  duration,
                  shouldRestart: true
                });
              } else {
                throw new Error('Token not found in database after refresh');
              }
            } catch (dbError) {
              console.error('\n[Token Refresh] ✗ Database verification failed:', dbError.message);
              resolve({
                success: false,
                error: 'Token refresh completed but database verification failed'
              });
            }
          } else {
            console.error(`\n[Token Refresh] ✗ Python script failed with code ${code}`);
            console.error(`[Token Refresh] Duration: ${duration}s\n`);
            
            resolve({
              success: false,
              error: `Python script exited with code ${code}`,
              output: errorOutput || output
            });
          }
        });
        
        pythonProcess.on('error', (error) => {
          console.error('\n[Token Refresh] ✗ Failed to spawn Python process:', error.message);
          
          resolve({
            success: false,
            error: `Failed to run Python: ${error.message}`,
            note: 'Make sure Python is installed and in PATH'
          });
        });
        
      } catch (error) {
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.error(`\n[Token Refresh] ✗ Error after ${duration}s:`, error.message);
        
        resolve({
          success: false,
          error: error.message
        });
      }
    });
  }
}

module.exports = UpstoxTokenRefresh;
