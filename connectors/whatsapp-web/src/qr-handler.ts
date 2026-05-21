import QRCode from 'qrcode';
import { EventEmitter } from 'events';

export class QRHandler extends EventEmitter {
  private currentQR: string | null = null;
  private qrExpiresAt: Date | null = null;

  async generateQR(qrString: string): Promise<string> {
    try {
      const qrCode = await QRCode.toDataURL(qrString, {
        errorCorrectionLevel: 'M',
        type: 'image/png',
        width: 300,
        margin: 1,
      });

      this.currentQR = qrCode;
      this.qrExpiresAt = new Date(Date.now() + 60 * 1000); // QR expires in 60 seconds

      this.emit('qr-generated', qrCode);

      return qrCode;
    } catch (error) {
      throw new Error(`Failed to generate QR code: ${String(error)}`);
    }
  }

  getCurrentQR(): { qrCode: string; expiresAt: Date } | null {
    if (!this.currentQR || !this.qrExpiresAt) {
      return null;
    }

    if (new Date() > this.qrExpiresAt) {
      this.currentQR = null;
      this.qrExpiresAt = null;
      return null;
    }

    return {
      qrCode: this.currentQR,
      expiresAt: this.qrExpiresAt,
    };
  }

  clearQR(): void {
    this.currentQR = null;
    this.qrExpiresAt = null;
  }
}
