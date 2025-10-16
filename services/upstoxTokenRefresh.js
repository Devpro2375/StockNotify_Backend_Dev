const { spawn } = require('child_process');
const AccessToken = require('../models/AccessToken');

class UpstoxTokenRefresh {
  async refreshToken() {
    const startTime = Date.now();
    
    return new Promise((resolve) => {
      try {
        console.log('[Token Refresh] ========================================');
        console.log(`[Token Refresh] Starting at ${new Date().toISOString()}`);
        console.log('[Token Refresh] Running Python script...');
        
        // Spawn Python process
        const pythonProcess = spawn('python', ['python-scripts/refresh_upstox_token.py'], {
          env: process.env,
          cwd: process.cwd()
        });
        
        let output = '';
        let errorOutput = '';
        
        pythonProcess.stdout.on('data', (data) => {
          const text = data.toString();
          output += text;
          // Log Python output in real-time
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
            console.log('[Token Refresh] ✓ Python script completed successfully');
            
            // Verify token was saved to database
            try {
              const tokenDoc = await AccessToken.findOne();
              
              if (tokenDoc && tokenDoc.token) {
                console.log('[Token Refresh] ✓ Token verified in MongoDB');
                console.log(`[Token Refresh] User: ${tokenDoc.user_name}`);
                console.log(`[Token Refresh] Expires: ${tokenDoc.expires_at}`);
                console.log(`[Token Refresh] Duration: ${duration}s`);
                console.log('[Token Refresh] ========================================');
                
                resolve({
                  success: true,
                  expiresAt: tokenDoc.expires_at,
                  duration
                });
              } else {
                throw new Error('Token not found in database after refresh');
              }
            } catch (dbError) {
              console.error('[Token Refresh] ✗ Database verification failed:', dbError.message);
              resolve({
                success: false,
                error: 'Token refresh completed but database verification failed'
              });
            }
          } else {
            console.error(`[Token Refresh] ✗ Python script failed with code ${code}`);
            console.error(`[Token Refresh] Duration: ${duration}s`);
            console.error('[Token Refresh] ========================================');
            
            resolve({
              success: false,
              error: `Python script exited with code ${code}`,
              output: errorOutput || output
            });
          }
        });
        
        pythonProcess.on('error', (error) => {
          console.error('[Token Refresh] ✗ Failed to spawn Python process:', error.message);
          console.error('[Token Refresh] ========================================');
          
          resolve({
            success: false,
            error: `Failed to run Python: ${error.message}`,
            note: 'Make sure Python is installed and in PATH'
          });
        });
        
      } catch (error) {
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.error(`[Token Refresh] ✗ Error after ${duration}s:`, error.message);
        console.error('[Token Refresh] ========================================');
        
        resolve({
          success: false,
          error: error.message
        });
      }
    });
  }
}

module.exports = UpstoxTokenRefresh;
