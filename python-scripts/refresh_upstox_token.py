#!/usr/bin/env python3
"""
Railway-Optimized Upstox Token Auto-Refresh Script
Windows-compatible version with proper Unicode handling
"""

import os
import sys
import logging
from datetime import datetime, timedelta
from typing import Optional, Dict
from pathlib import Path

# Fix Windows encoding issue
if sys.platform == 'win32':
    # Force UTF-8 encoding for Windows console
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

# Load .env for local testing
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# Ensure logs directory exists
log_dir = Path(__file__).parent.parent / 'logs'
log_dir.mkdir(exist_ok=True)

# Configure logging (Windows-safe)
class WindowsSafeFormatter(logging.Formatter):
    """Formatter that removes emojis on Windows"""
    def format(self, record):
        msg = super().format(record)
        if sys.platform == 'win32':
            # Remove emojis for Windows
            emoji_map = {
                '🚀': '[START]',
                '✅': '[OK]',
                '❌': '[ERROR]',
                '🔌': '[DB]',
                '🔑': '[AUTH]',
                '🔄': '[REFRESH]',
                '💡': '[INFO]',
                '⚠️': '[WARN]',
                '🎉': '[SUCCESS]',
                '👋': '[EXIT]',
                '📱': '[ALERT]',
                '🚨': '[CRITICAL]'
            }
            for emoji, text in emoji_map.items():
                msg = msg.replace(emoji, text)
        return msg

handler_console = logging.StreamHandler(sys.stdout)
handler_console.setFormatter(WindowsSafeFormatter('%(asctime)s [%(levelname)s] %(message)s'))

handler_file = logging.FileHandler(log_dir / 'token_refresh.log', encoding='utf-8')
handler_file.setFormatter(logging.Formatter('%(asctime)s [%(levelname)s] %(message)s'))

logging.basicConfig(
    level=logging.INFO,
    handlers=[handler_file, handler_console]
)
logger = logging.getLogger(__name__)

# Import dependencies
try:
    from pymongo import MongoClient
    from pymongo.errors import ConnectionFailure, OperationFailure
    from upstox_totp import UpstoxTOTP, UpstoxError, ConfigurationError
    import requests
except ImportError as e:
    logger.error(f"[ERROR] Missing dependency: {e}")
    logger.error("[INFO] Run: pip install -r python-scripts/requirements.txt")
    sys.exit(1)


class RailwayTokenManager:
    """Manages Upstox token generation with Railway and Windows compatibility"""
    
    def __init__(self):
        # Load from environment
        self.mongo_uri = os.getenv('MONGO_URI') or os.getenv('DATABASE_URL')
        self.db_name = self._extract_db_name(self.mongo_uri)
        self.client: Optional[MongoClient] = None
        self.upx: Optional[UpstoxTOTP] = None
        
        # Telegram notification settings (optional)
        self.telegram_bot_token = os.getenv('TELEGRAM_BOT_TOKEN')
        self.admin_chat_id = os.getenv('ADMIN_TELEGRAM_CHAT_ID')
        
    def _extract_db_name(self, uri: str) -> str:
        """Extract database name from MongoDB URI"""
        if not uri:
            logger.error("[ERROR] MONGO_URI not found in environment variables")
            logger.error("[INFO] For Railway: Set in project settings")
            logger.error("[INFO] For local: Create .env file in project root")
            sys.exit(1)
        try:
            db = uri.split('/')[-1].split('?')[0]
            return db if db else 'stock_alerts_db'
        except Exception:
            return 'stock_alerts_db'
    
    def connect_mongodb(self) -> bool:
        """Establish MongoDB connection"""
        logger.info(f"[DB] Connecting to MongoDB: {self.db_name}")
        max_retries = 3
        
        for attempt in range(max_retries):
            try:
                self.client = MongoClient(
                    self.mongo_uri,
                    serverSelectionTimeoutMS=10000,
                    connectTimeoutMS=15000,
                    socketTimeoutMS=15000,
                    maxPoolSize=1
                )
                
                # Verify connection
                self.client.admin.command('ping')
                logger.info(f"[OK] MongoDB connected: {self.db_name}")
                return True
                
            except (ConnectionFailure, OperationFailure) as e:
                logger.error(f"[ERROR] Attempt {attempt + 1}/{max_retries} failed: {e}")
                if attempt == max_retries - 1:
                    self.send_alert("MongoDB connection failed after 3 retries")
                    return False
        
        return False
    
    def initialize_upstox(self) -> bool:
        """Initialize Upstox TOTP client"""
        logger.info("[AUTH] Initializing Upstox TOTP client...")
        
        required_vars = {
            'UPSTOX_USERNAME': os.getenv('UPSTOX_USERNAME'),
            'UPSTOX_PASSWORD': os.getenv('UPSTOX_PASSWORD'),
            'UPSTOX_PIN_CODE': os.getenv('UPSTOX_PIN_CODE'),
            'UPSTOX_TOTP_SECRET': os.getenv('UPSTOX_TOTP_SECRET'),
            'UPSTOX_CLIENT_ID': os.getenv('UPSTOX_CLIENT_ID'),
            'UPSTOX_CLIENT_SECRET': os.getenv('UPSTOX_CLIENT_SECRET')
        }
        
        # Validate and show which variables are missing
        missing = [name for name, value in required_vars.items() if not value]
        
        if missing:
            logger.error(f"[ERROR] Missing environment variables:")
            for var in missing:
                logger.error(f"  - {var}")
            logger.error("")
            logger.error("[INFO] For Railway: Go to Project → Settings → Variables")
            logger.error("[INFO] For local testing: Create .env file with these variables")
            logger.error("")
            logger.error("Example .env file:")
            logger.error("UPSTOX_USERNAME=9876543210")
            logger.error("UPSTOX_PASSWORD=your_password")
            logger.error("UPSTOX_PIN_CODE=1234")
            logger.error("UPSTOX_TOTP_SECRET=ABCD1234EFGH5678")
            logger.error("UPSTOX_CLIENT_ID=your_api_key")
            logger.error("UPSTOX_CLIENT_SECRET=your_secret")
            
            self.send_alert(f"Missing env vars: {', '.join(missing)}")
            return False
        
        try:
            self.upx = UpstoxTOTP(
                username=required_vars['UPSTOX_USERNAME'],
                password=required_vars['UPSTOX_PASSWORD'],
                pin_code=required_vars['UPSTOX_PIN_CODE'],
                totp_secret=required_vars['UPSTOX_TOTP_SECRET'],
                client_id=required_vars['UPSTOX_CLIENT_ID'],
                client_secret=required_vars['UPSTOX_CLIENT_SECRET'],
                redirect_uri=os.getenv('UPSTOX_REDIRECT_URI', 'http://localhost'),
                debug=False
            )
            logger.info("[OK] Upstox TOTP client initialized")
            return True
            
        except ConfigurationError as e:
            logger.error(f"[ERROR] Configuration error: {e}")
            self.send_alert(f"Upstox config error: {str(e)}")
            return False
        except Exception as e:
            logger.error(f"[ERROR] Unexpected error: {e}")
            return False
    
    def generate_access_token(self) -> Optional[Dict]:
        """Generate fresh access token from Upstox"""
        logger.info("[REFRESH] Generating new access token...")
        
        try:
            response = self.upx.app_token.get_access_token()
            
            if response.success and response.data:
                token_data = {
                    'access_token': response.data.access_token,
                    'user_id': response.data.user_id,
                    'user_name': response.data.user_name,
                    'email': response.data.email,
                    'broker': response.data.broker,
                    'products': response.data.products,
                    'exchanges': response.data.exchanges,
                    'is_active': response.data.is_active
                }
                
                logger.info(f"[OK] Token generated successfully")
                logger.info(f"     User: {token_data['user_name']} ({token_data['user_id']})")
                logger.info(f"     Email: {token_data['email']}")
                logger.info(f"     Broker: {token_data['broker']}")
                
                return token_data
            else:
                error_msg = response.error if hasattr(response, 'error') else "Unknown error"
                logger.error(f"[ERROR] Token generation failed: {error_msg}")
                self.send_alert(f"Token generation failed: {error_msg}")
                return None
                
        except UpstoxError as e:
            logger.error(f"[ERROR] Upstox API error: {e}")
            self.send_alert(f"Upstox API error: {str(e)}")
            return None
        except Exception as e:
            logger.error(f"[ERROR] Unexpected error: {e}")
            self.send_alert(f"Unexpected error: {str(e)}")
            return None
    
    def update_token_in_db(self, token_data: Dict) -> bool:
        """Update token in MongoDB AccessToken collection"""
        try:
            db = self.client[self.db_name]
            collection = db['accesstokens']
            
            from datetime import timezone
            now = datetime.now(timezone.utc)
            expires_at = now + timedelta(hours=23, minutes=30)
            
            update_doc = {
                '$set': {
                    'token': token_data['access_token'],
                    'user_id': token_data['user_id'],
                    'user_name': token_data['user_name'],
                    'email': token_data['email'],
                    'broker': token_data['broker'],
                    'updated_at': now,
                    'expires_at': expires_at,
                    'metadata': {
                        'products': token_data['products'],
                        'exchanges': token_data['exchanges'],
                        'is_active': token_data['is_active'],
                        'last_refresh_source': 'railway_cron',
                        'railway_env': os.getenv('RAILWAY_ENVIRONMENT', 'local')
                    }
                }
            }
            
            result = collection.update_one({}, update_doc, upsert=True)
            
            if result.modified_count > 0 or result.upserted_id:
                logger.info(f"[OK] Token saved to MongoDB")
                logger.info(f"     Collection: {collection.name}")
                logger.info(f"     Expires at: {expires_at.strftime('%Y-%m-%d %H:%M:%S')} UTC")
                return True
            else:
                logger.warning("[WARN] No document modified (token may be same)")
                return True
                
        except Exception as e:
            logger.error(f"[ERROR] MongoDB update failed: {e}")
            self.send_alert(f"MongoDB update failed: {str(e)}")
            return False
    
    def send_alert(self, message: str):
        """Send Telegram notification (optional)"""
        if not self.telegram_bot_token or not self.admin_chat_id:
            return
        
        try:
            url = f'https://api.telegram.org/bot{self.telegram_bot_token}/sendMessage'
            payload = {
                'chat_id': self.admin_chat_id,
                'text': f"**Upstox Token Refresh Alert**\n\n{message}\n\nTime: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
                'parse_mode': 'Markdown'
            }
            
            response = requests.post(url, json=payload, timeout=5)
            if response.status_code == 200:
                logger.info("[ALERT] Telegram notification sent")
        except Exception as e:
            logger.warning(f"[WARN] Failed to send Telegram alert: {e}")
    
    def run(self) -> bool:
        """Main execution flow"""
        start_time = datetime.now()
        logger.info("=" * 70)
        logger.info(f"[START] Upstox Token Refresh Started")
        logger.info(f"        Railway Environment: {os.getenv('RAILWAY_ENVIRONMENT', 'local')}")
        logger.info(f"        Railway Service: {os.getenv('RAILWAY_SERVICE_NAME', 'N/A')}")
        logger.info(f"        Platform: {sys.platform}")
        logger.info("=" * 70)
        
        success = False
        
        try:
            # Step 1: Connect to MongoDB
            if not self.connect_mongodb():
                return False
            
            # Step 2: Initialize Upstox
            if not self.initialize_upstox():
                return False
            
            # Step 3: Generate token
            token_data = self.generate_access_token()
            if not token_data:
                return False
            
            # Step 4: Save to database
            if not self.update_token_in_db(token_data):
                return False
            
            # Success!
            success = True
            execution_time = (datetime.now() - start_time).total_seconds()
            
            logger.info("=" * 70)
            logger.info(f"[SUCCESS] Token Refresh Completed!")
            logger.info(f"          Execution time: {execution_time:.2f} seconds")
            logger.info("=" * 70)
            
            # Optional success notification
            if os.getenv('SEND_SUCCESS_ALERTS', 'false').lower() == 'true':
                self.send_alert(f"Token refreshed successfully in {execution_time:.1f}s")
            
            return True
            
        except Exception as e:
            logger.error(f"[ERROR] Unexpected error in run(): {e}")
            self.send_alert(f"Critical error: {str(e)}")
            return False
            
        finally:
            # Cleanup
            if self.client:
                self.client.close()
                logger.info("[DB] MongoDB connection closed")
            
            # Exit info
            exit_code = 0 if success else 1
            logger.info(f"[EXIT] Exiting with code {exit_code}")


def main():
    """Entry point for Railway cron job"""
    manager = RailwayTokenManager()
    success = manager.run()
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
