import { CertificateTransferService } from './certificate-transfer.service';
import { TransferStatus } from '../entities/certificate-transfer.entity';
import { NotificationType } from '../../notifications/entities/notification.entity';
import { UserRole } from '../../../common/constants/roles';

describe('CertificateTransferService', () => {
  let service: CertificateTransferService;
  let transferRepo: any;
  let certRepo: any;
  let auditService: any;
  let notificationsService: any;
  let logger: any;
  let userRepo: any;
  let emailService: any;
  let feeCharger: any;

  beforeEach(() => {
    transferRepo = {
      create: jest.fn((dto) => ({ id: 'transfer-1', ...dto })),
      save: jest.fn((entity) => Promise.resolve(entity)),
      findOne: jest.fn(),
    };

    certRepo = {
      findOne: jest.fn(),
      save: jest.fn((entity) => Promise.resolve(entity)),
    };

    auditService = {
      log: jest.fn().mockResolved(undefined),
    };

    notificationsService = {
      createNotification: jest.fn().mockResolved({ id: 'notif-1' }),
    };

    logger = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    userRepo = {
      findOne: jest.fn(),
    };

    emailService = {
      sendTransferConfirmationCode: jest.fn().mockResolved(undefined),
      sendTransferCompletedNotice: jest.fn().mockResolved(undefined),
    };

    feeCharger = {
      chargeTransferFee: jest
        .fn()
        .mockResolved({ transactionHash: 'tx-hash-1' }),
    };

    service = new CertificateTransferService(
      transferRepo,
      certRepo,
      auditService,
      notificationsService,
      logger,
      userRepo,
      emailService,
      feeCharger,
    );
  });

  describe('initiateTransfer', () => {
    it('sends confirmation code to toEmail (notification & email), not initiator', async () => {
      const mockCert = {
        id: 'cert-1',
        title: 'Blockchain Certified Developer',
        issuerId: 'issuer-1',
        recipientEmail: 'old@example.com',
        recipientName: 'Old Owner',
        status: 'active',
      };
      certRepo.findOne.mockResolved(mockCert);

      const recipientUser = {
        id: 'user-recipient-99',
        email: 'newowner@example.com',
        firstName: 'New',
        lastName: 'Owner',
      };
      userRepo.findOne.mockResolved(recipientUser);

      const dto = {
        certificateId: 'cert-1',
        newOwnerEmail: 'newowner@example.com',
        newOwnerName: 'New Owner',
        reason: 'Change of legal name/address',
      };

      const result = await service.initiateTransfer(
        dto,
        { id: 'issuer-1', role: UserRole.ISSUER },
        '127.0.0.1',
      );

      expect(result).toBeDefined();
      const code = result.confirmationCode!;
      expect(code).toBeDefined();

      // 1. Initiator notification must NOT contain confirmationCode
      expect(notificationsService.createNotification).toHaveBeenCalledWith(
        'issuer-1',
        NotificationType.INFO,
        'Certificate Transfer Initiated',
        expect.not.stringContaining(code),
      );

      // 2. Intended recipient user notification MUST contain confirmationCode
      expect(notificationsService.createNotification).toHaveBeenCalledWith(
        'user-recipient-99',
        NotificationType.INFO,
        'Certificate Transfer Confirmation Code',
        expect.stringContaining(code),
      );

      // 3. Email MUST be sent to newOwnerEmail with confirmationCode
      expect(emailService.sendTransferConfirmationCode).toHaveBeenCalledWith({
        to: 'newowner@example.com',
        recipientName: 'New Owner',
        certificateTitle: 'Blockchain Certified Developer',
        certificateId: 'cert-1',
        confirmationCode: code,
      });
    });
  });

  describe('approveTransfer', () => {
    it('notifies both approver and recipient (toEmail) on completion', async () => {
      const mockTransfer = {
        id: 'transfer-1',
        certificateId: 'cert-1',
        fromEmail: 'old@example.com',
        fromName: 'Old Owner',
        toEmail: 'newowner@example.com',
        toName: 'New Owner',
        confirmationCode: '123456',
        transferFee: '0',
        status: TransferStatus.PENDING,
        certificate: {
          id: 'cert-1',
          title: 'Blockchain Certified Developer',
          issuerId: 'issuer-1',
          recipientEmail: 'old@example.com',
          recipientName: 'Old Owner',
          status: 'active',
          metadata: {},
        },
      };

      transferRepo.findOne.mockResolved(mockTransfer);
      certRepo.findOne.mockResolved(mockTransfer.certificate);

      const recipientUser = {
        id: 'user-recipient-99',
        email: 'newowner@example.com',
        firstName: 'New',
      };
      userRepo.findOne.mockResolved(recipientUser);

      await service.approveTransfer(
        'transfer-1',
        '123456',
        { id: 'approver-1', role: UserRole.ADMIN },
        '127.0.0.1',
      );

      // Approver notification
      expect(notificationsService.createNotification).toHaveBeenCalledWith(
        'approver-1',
        NotificationType.SUCCESS,
        'Certificate Transfer Completed',
        expect.stringContaining('newowner@example.com'),
      );

      // Recipient user notification
      expect(notificationsService.createNotification).toHaveBeenCalledWith(
        'user-recipient-99',
        NotificationType.SUCCESS,
        'Certificate Transfer Completed',
        expect.stringContaining('successfully transferred to your account'),
      );

      // Completion email to new owner
      expect(emailService.sendTransferCompletedNotice).toHaveBeenCalledWith({
        to: 'newowner@example.com',
        recipientName: 'New Owner',
        certificateTitle: 'Blockchain Certified Developer',
        certificateId: 'cert-1',
      });
    });

    it('charges the transfer fee via SAC token transfer when transfer_fee > 0', async () => {
      const mockTransfer = {
        id: 'transfer-1',
        certificateId: 'cert-1',
        fromEmail: 'old@example.com',
        fromName: 'Old Owner',
        toEmail: 'newowner@example.com',
        toName: 'New Owner',
        confirmationCode: '123456',
        transferFee: '250',
        initiatedBy: 'payer-1',
        status: TransferStatus.PENDING,
        certificate: {
          id: 'cert-1',
          title: 'Blockchain Certified Developer',
          issuerId: 'issuer-1',
          recipientEmail: 'old@example.com',
          recipientName: 'Old Owner',
          status: 'active',
          metadata: {},
          issuerWalletAddress: 'GRECIPIENT-ADDRESS',
        },
      };

      transferRepo.findOne.mockResolved(mockTransfer);
      certRepo.findOne.mockResolved(mockTransfer.certificate);
      userRepo.findOne.mockResolved({
        id: 'payer-1',
        walletAddress: 'GPAYER-ADDRESS',
      });

      await service.approveTransfer(
        'transfer-1',
        '123456',
        { id: 'approver-1', role: UserRole.ADMIN },
        '127.0.0.1',
      );

      expect(feeCharger.chargeTransferFee).toHaveBeenCalledTimes(1);
      expect(feeCharger.chargeTransferFee).toHaveBeenCalledWith(
        expect.objectContaining({
          transferId: 'transfer-1',
          feeAmount: BigInt(250),
          payerId: 'payer-1',
          payerAddress: 'GPAYER-ADDRESS',
          recipientAddress: 'GRECIPIENT-ADDRESS',
        }),
      );
      expect(mockTransfer.feePaid).toBe(true);
      expect(mockTransfer.feeTransactionHash).toBe('tx-hash-1');
    });

    it('does not charge a fee when transfer_fee is zero', async () => {
      const mockTransfer = {
        id: 'transfer-1',
        certificateId: 'cert-1',
        fromEmail: 'old@example.com',
        fromName: 'Old Owner',
        toEmail: 'newowner@example.com',
        toName: 'New Owner',
        confirmationCode: '123456',
        transferFee: '0',
        status: TransferStatus.PENDING,
        certificate: {
          id: 'cert-1',
          title: 'Blockchain Certified Developer',
          issuerId: 'issuer-1',
          recipientEmail: 'old@example.com',
          recipientName: 'Old Owner',
          status: 'active',
          metadata: {},
        },
      };

      transferRepo.findOne.mockResolved(mockTransfer);
      certRepo.findOne.mockResolved(mockTransfer.certificate);
      userRepo.findOne.mockResolved(null);

      await service.approveTransfer(
        'transfer-1',
        '123456',
        { id: 'approver-1', role: UserRole.ADMIN },
        '127.0.0.1',
      );

      expect(feeCharger.chargeTransferFee).not.toHaveBeenCalled();
    });

    it('does not complete the transfer when the fee transfer fails', async () => {
      const mockTransfer = {
        id: 'transfer-1',
        certificateId: 'cert-1',
        fromEmail: 'old@example.com',
        fromName: 'Old Owner',
        toEmail: 'newowner@example.com',
        toName: 'New Owner',
        confirmationCode: '123456',
        transferFee: '250',
        initiatedBy: 'payer-1',
        status: TransferStatus.PENDING,
        certificate: {
          id: 'cert-1',
          title: 'Blockchain Certified Developer',
          issuerId: 'issuer-1',
          recipientEmail: 'old@example.com',
          recipientName: 'Old Owner',
          status: 'active',
          metadata: {},
          issuerWalletAddress: 'GRECIPIENT-ADDRESS',
        },
      };

      transferRepo.findOne.mockResolved(mockTransfer);
      certRepo.findOne.mockResolved(mockTransfer.certificate);
      userRepo.findOne.mockResolved({
        id: 'payer-1',
        walletAddress: 'GPAYER-ADDRESS',
      });
      feeCharger.chargeTransferFee.mockRejected(
        new Error('insufficient balance'),
      );

      await expect(
        service.approveTransfer(
          'transfer-1',
          '123456',
          { id: 'approver-1', role: UserRole.ADMIN },
          '127.0.0.1',
        ),
      ).rejects.toThrow('insufficient balance');

      expect(certRepo.save).not.toHaveBeenCalled();
      expect(transferRepo.save).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: TransferStatus.APPROVED }),
      );
    });

    it('throws when fee is required but no fee charger is configured', async () => {
      const serviceWithoutCharger = new CertificateTransferService(
        transferRepo,
        certRepo,
        auditService,
        notificationsService,
        logger,
        userRepo,
        emailService,
        undefined,
      );

      const mockTransfer = {
        id: 'transfer-1',
        certificateId: 'cert-1',
        fromEmail: 'old@example.com',
        fromName: 'Old Owner',
        toEmail: 'newowner@example.com',
        toName: 'New Owner',
        confirmationCode: '123456',
        transferFee: '250',
        initiatedBy: 'payer-1',
        status: TransferStatus.PENDING,
        certificate: {
          id: 'cert-1',
          title: 'Blockchain Certified Developer',
          issuerId: 'issuer-1',
          recipientEmail: 'old@example.com',
          recipientName: 'Old Owner',
          status: 'active',
          metadata: {},
          issuerWalletAddress: 'GRECIPIENT-ADDRESS',
        },
      };

      transferRepo.findOne.mockResolved(mockTransfer);
      certRepo.findOne.mockResolved(mockTransfer.certificate);
      userRepo.findOne.mockResolved({
        id: 'payer-1',
        walletAddress: 'GPAYER-ADDRESS',
      });

      await expect(
        serviceWithoutCharger.approveTransfer(
          'transfer-1',
          '123456',
          { id: 'approver-1', role: UserRole.ADMIN },
          '127.0.0.1',
        ),
      ).rejects.toThrow('no fee charger is configured');
    });
  });
});
