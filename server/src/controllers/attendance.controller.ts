import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { AttendanceSession } from '../models/Attendance';
import { Student } from '../models/Student';
import { Faculty } from '../models/Faculty';
import { getHuman, imageBase64ToTensor } from '../services/human';

// Face matching threshold (cosine similarity) - very low for mock embeddings
const FACE_MATCH_THRESHOLD = 0.1;

// Rate limiting for session creation
const sessionCreationTimes = new Map<string, number>();
const SESSION_CREATION_COOLDOWN = 5000; // 5 seconds

// Calculate cosine similarity between two face descriptors
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  
  if (normA === 0 || normB === 0) return 0;
  
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Find best matching student for a face descriptor
async function findMatchingStudent(
  faceDescriptor: number[], 
  enrolledStudents: any[]
): Promise<{ student: any; confidence: number } | null> {
  let bestMatch = null;
  let bestConfidence = 0;
  
  console.log('🔍 Finding matching student...');
  console.log('Input descriptor length:', faceDescriptor.length);
  console.log('Enrolled students count:', enrolledStudents.length);
  
  for (const student of enrolledStudents) {
    if (!student.faceDescriptor || student.faceDescriptor.length === 0) {
      console.log(`⚠️ Student ${student.name} has no face descriptor`);
      continue;
    }
    
    const similarity = cosineSimilarity(faceDescriptor, student.faceDescriptor);
    console.log(`📊 Comparing with ${student.name}: similarity = ${similarity.toFixed(4)}`);
    
    if (similarity > bestConfidence && similarity >= FACE_MATCH_THRESHOLD) {
      bestConfidence = similarity;
      bestMatch = student;
      console.log(`✅ New best match: ${student.name} with confidence ${similarity.toFixed(4)}`);
    }
  }
  
  console.log(`🎯 Final result: ${bestMatch ? `Match found: ${bestMatch.name} (${bestConfidence.toFixed(4)})` : 'No match found'}`);
  return bestMatch ? { student: bestMatch, confidence: bestConfidence } : null;
}

// Start attendance session
export async function startAttendanceSession(req: Request, res: Response): Promise<void> {
  try {
    const facultyId = req.userId;
    const { subject, section, sessionType, hours } = req.body;
    
    if (!facultyId || !mongoose.isValidObjectId(facultyId)) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }
    
    // Rate limiting check
    const rateLimitKey = `${facultyId}-${subject}-${section}`;
    const lastCreationTime = sessionCreationTimes.get(rateLimitKey);
    const now = Date.now();
    
    if (lastCreationTime && (now - lastCreationTime) < SESSION_CREATION_COOLDOWN) {
      res.status(429).json({ 
        message: 'Please wait before creating another session',
        retryAfter: Math.ceil((SESSION_CREATION_COOLDOWN - (now - lastCreationTime)) / 1000)
      });
      return;
    }
    
    sessionCreationTimes.set(rateLimitKey, now);
    
    if (!subject || !section || !sessionType || !hours || !Array.isArray(hours)) {
      res.status(400).json({ message: 'subject, section, sessionType, and hours are required' });
      return;
    }
    
    // Check if session already exists for today
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const existingSession = await AttendanceSession.findOne({
      facultyId: new mongoose.Types.ObjectId(facultyId),
      subject,
      section,
      sessionType,
      date: today
    });
    
    if (existingSession) {
      res.status(200).json({
        message: 'Attendance session already exists for today',
        sessionId: existingSession._id,
        totalStudents: existingSession.totalStudents,
        students: existingSession.records.map(r => ({
          id: r.studentId,
          name: r.studentName,
          rollNumber: r.rollNumber,
          isPresent: r.isPresent
        }))
      });
      return;
    }
    
    // Get enrolled students for this subject/section
    const enrolledStudents = await Student.find({
      'enrollments.subject': subject,
      'enrollments.section': section,
      'enrollments.facultyId': new mongoose.Types.ObjectId(facultyId)
    }).select('name rollNumber faceDescriptor');
    
    if (enrolledStudents.length === 0) {
      res.status(404).json({ 
        message: 'No students enrolled in this subject/section',
        hint: 'Please register students for this subject/section first'
      });
      return;
    }
    
    // Create attendance session
    
    const attendanceSession = await AttendanceSession.create({
      facultyId: new mongoose.Types.ObjectId(facultyId),
      subject,
      section,
      sessionType,
      hours,
      date: today,
      totalStudents: enrolledStudents.length,
      presentStudents: 0,
      absentStudents: enrolledStudents.length,
      records: enrolledStudents.map(student => ({
        studentId: student._id,
        studentName: student.name,
        rollNumber: student.rollNumber,
        isPresent: false,
        markedAt: new Date()
      }))
    });
    
    res.status(201).json({
      message: 'Attendance session started',
      sessionId: attendanceSession._id,
      totalStudents: enrolledStudents.length,
      students: enrolledStudents.map(s => ({
        id: s._id,
        name: s.name,
        rollNumber: s.rollNumber,
        hasFaceDescriptor: !!(s.faceDescriptor && s.faceDescriptor.length > 0)
      }))
    });
    
  } catch (error) {
    console.error('Start attendance session error:', error);
    res.status(500).json({ message: 'Failed to start attendance session' });
  }
}

// Mark attendance using face detection
export async function markAttendance(req: Request, res: Response): Promise<void> {
  try {
    const facultyId = req.userId;
    const { sessionId, faceDescriptor, faceImageBase64 } = req.body;
    
    if (!facultyId || !mongoose.isValidObjectId(facultyId)) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }
    
    if (!sessionId || !mongoose.isValidObjectId(sessionId)) {
      res.status(400).json({ message: 'Valid sessionId is required' });
      return;
    }
    
    // Get attendance session
    const session = await AttendanceSession.findById(sessionId);
    if (!session) {
      res.status(404).json({ message: 'Attendance session not found' });
      return;
    }
    
    // Verify faculty owns this session
    if (String(session.facultyId) !== String(facultyId)) {
      res.status(403).json({ message: 'Unauthorized to access this session' });
      return;
    }
    
    let finalDescriptor: number[] = [];
    
    // Process face descriptor
    if (faceDescriptor && faceDescriptor.length > 0) {
      finalDescriptor = faceDescriptor;
    } else if (faceImageBase64) {
      // Process face on server
      try {
        const imageData = await imageBase64ToTensor(faceImageBase64);
        const human = await getHuman();
        
        // Check if we're using real Human library or fallback
        if (human.detect && typeof human.detect === 'function') {
          // Real Human library
          console.log('🔄 Using real Human library for face detection...');
          const result = await human.detect(imageData);
          
          if (!result.face || result.face.length === 0) {
            res.status(400).json({ 
              message: 'No face detected in the provided image',
              hint: 'Please ensure the image contains a clear face'
            });
            return;
          }
          
          const faceDescriptor = result.face[0].embedding;
          if (!faceDescriptor || faceDescriptor.length === 0) {
            res.status(400).json({ 
              message: 'Could not extract face features from the image',
              hint: 'Please ensure the face is clearly visible and well-lit'
            });
            return;
          }
          
          finalDescriptor = Array.from(faceDescriptor);
          console.log('✅ Real face descriptor extracted, length:', finalDescriptor.length);
        } else {
          // Fallback to mock detection
          console.log('🔄 Using mock face detection...');
          const result = await human.detect(imageData);
          finalDescriptor = Array.from(result.face[0].embedding);
          console.log('✅ Mock face descriptor generated, length:', finalDescriptor.length);
        }
      } catch (error: any) {
        console.error('Server-side face processing error:', error);
        res.status(500).json({ 
          message: 'Failed to process face image on server',
          hint: 'Please try capturing the image again with better lighting'
        });
        return;
      }
    } else {
      res.status(400).json({ 
        message: 'Face data is required',
        hint: 'Please provide either faceDescriptor or faceImageBase64'
      });
      return;
    }
    
    // Get enrolled students for matching
    const enrolledStudents = await Student.find({
      'enrollments.subject': session.subject,
      'enrollments.section': session.section,
      'enrollments.facultyId': session.facultyId
    }).select('_id name rollNumber faceDescriptor');
    
    // Find matching student
    const match = await findMatchingStudent(finalDescriptor, enrolledStudents);
    
    if (!match) {
      res.status(404).json({ 
        message: 'No matching student found',
        hint: 'Face does not match any enrolled student. Please ensure the student is registered for this subject/section.'
      });
      return;
    }
    
    // Update attendance record
    console.log('🔍 Looking for student in session records...');
    console.log('Match student ID:', match.student._id);
    console.log('Session records count:', session.records.length);
    console.log('Session records:', session.records.map(r => ({ id: r.studentId, name: r.studentName })));
    
    const recordIndex = session.records.findIndex(
      record => String(record.studentId) === String(match.student._id)
    );
    
    console.log('Record index found:', recordIndex);
    
    if (recordIndex === -1) {
      console.log('❌ Student not found in attendance session records');
      console.log('🔄 Attempting to refresh session with latest enrolled students...');
      
      // Try to refresh the session with latest enrolled students
      const latestEnrolledStudents = await Student.find({
        'enrollments.subject': session.subject,
        'enrollments.section': session.section,
        'enrollments.facultyId': session.facultyId
      }).select('_id name rollNumber faceDescriptor');
      
      // Check if the student exists in the latest enrollment
      const studentExists = latestEnrolledStudents.find(s => String(s._id) === String(match.student._id));
      
      if (studentExists) {
        console.log('✅ Student found in latest enrollment, adding to session...');
        
        // Add the student to the session records
        session.records.push({
          studentId: match.student._id,
          studentName: match.student.name,
          rollNumber: match.student.rollNumber,
          isPresent: false,
          markedAt: new Date()
        });
        
        session.totalStudents += 1;
        session.absentStudents += 1;
        
        await session.save();
        
        // Now proceed with marking attendance
        const newRecordIndex = session.records.length - 1;
        const record = session.records[newRecordIndex];
        
        record.isPresent = true;
        record.markedAt = new Date();
        record.confidence = Math.min(1.0, Math.max(0.0, match.confidence));
        
        session.presentStudents += 1;
        session.absentStudents -= 1;
        
        await session.save();
        
        res.json({
          message: 'Attendance marked successfully (student added to session)',
          student: {
            id: match.student._id,
            name: match.student.name,
            rollNumber: match.student.rollNumber,
            confidence: match.confidence
          },
          attendance: {
            present: session.presentStudents,
            absent: session.absentStudents,
            total: session.totalStudents
          }
        });
        return;
      } else {
        res.status(404).json({ 
          message: 'Student not found in attendance session',
          hint: 'The student may have been registered after the session was created. Please restart the attendance session.'
        });
        return;
      }
    }
    
    const record = session.records[recordIndex];
    const wasPresent = record.isPresent;
    
    if (!wasPresent) {
      // Mark as present
      record.isPresent = true;
      record.markedAt = new Date();
      // Clamp confidence to prevent floating-point precision issues
      record.confidence = Math.min(1.0, Math.max(0.0, match.confidence));
      
      session.presentStudents += 1;
      session.absentStudents -= 1;
      
      await session.save();
      
      res.json({
        message: 'Attendance marked successfully',
        student: {
          id: match.student._id,
          name: match.student.name,
          rollNumber: match.student.rollNumber,
          confidence: match.confidence
        },
        attendance: {
          present: session.presentStudents,
          absent: session.absentStudents,
          total: session.totalStudents
        }
      });
    } else {
      res.json({
        message: 'Student already marked present',
        student: {
          id: match.student._id,
          name: match.student.name,
          rollNumber: match.student.rollNumber
        },
        attendance: {
          present: session.presentStudents,
          absent: session.absentStudents,
          total: session.totalStudents
        }
      });
    }
    
  } catch (error) {
    console.error('Mark attendance error:', error);
    res.status(500).json({ message: 'Failed to mark attendance' });
  }
}

// Get attendance session details
export async function getAttendanceSession(req: Request, res: Response): Promise<void> {
  try {
    const facultyId = req.userId;
    const { sessionId } = req.params;
    
    if (!facultyId || !mongoose.isValidObjectId(facultyId)) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }
    
    if (!sessionId || !mongoose.isValidObjectId(sessionId)) {
      res.status(400).json({ message: 'Valid sessionId is required' });
      return;
    }
    
    const session = await AttendanceSession.findById(sessionId);
    if (!session) {
      res.status(404).json({ message: 'Attendance session not found' });
      return;
    }
    
    // Verify faculty owns this session
    if (String(session.facultyId) !== String(facultyId)) {
      res.status(403).json({ message: 'Unauthorized to access this session' });
      return;
    }
    
    // Separate present and absent students
    const presentStudents = session.records
      .filter(record => record.isPresent)
      .map(record => ({
        id: record.studentId,
        name: record.studentName,
        rollNumber: record.rollNumber,
        markedAt: record.markedAt,
        confidence: record.confidence,
        markedVia: 'Face Detection'
      }));

    const absentStudents = session.records
      .filter(record => !record.isPresent)
      .map(record => ({
        id: record.studentId,
        name: record.studentName,
        rollNumber: record.rollNumber
      }));

    res.json({
      session: {
        id: session._id,
        subject: session.subject,
        section: session.section,
        sessionType: session.sessionType,
        hours: session.hours,
        date: session.date,
        totalStudents: session.totalStudents,
        presentStudents: session.presentStudents,
        absentStudents: session.absentStudents,
        attendancePercentage: session.totalStudents > 0 
          ? Math.round((session.presentStudents / session.totalStudents) * 100) 
          : 0,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt
      },
      // Detailed student lists
      presentStudentsList: presentStudents,
      absentStudentsList: absentStudents,
      // Legacy records format for backward compatibility
      records: session.records.map(record => ({
        studentId: record.studentId,
        studentName: record.studentName,
        rollNumber: record.rollNumber,
        isPresent: record.isPresent,
        markedAt: record.markedAt,
        confidence: record.confidence
      }))
    });
    
  } catch (error) {
    console.error('Get attendance session error:', error);
    res.status(500).json({ message: 'Failed to get attendance session' });
  }
}

// Get attendance reports
export async function getAttendanceReports(req: Request, res: Response): Promise<void> {
  try {
    const facultyId = req.userId;
    const { subject, section, startDate, endDate } = req.query;
    
    if (!facultyId || !mongoose.isValidObjectId(facultyId)) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }
    
    // Build query
    const query: any = { facultyId: new mongoose.Types.ObjectId(facultyId) };
    
    if (subject) query.subject = subject;
    if (section) query.section = section;
    
    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate as string);
      if (endDate) query.date.$lte = new Date(endDate as string);
    }
    
    const sessions = await AttendanceSession.find(query)
      .sort({ date: -1, createdAt: -1 })
      .limit(100); // Limit to prevent large responses
    
    res.json({
      sessions: sessions.map(session => {
        // Separate present and absent students
        const presentStudents = session.records
          .filter(record => record.isPresent)
          .map(record => ({
            id: record.studentId,
            name: record.studentName,
            rollNumber: record.rollNumber,
            markedAt: record.markedAt,
            confidence: record.confidence,
            markedVia: 'Face Detection' // All attendance is marked via face detection
          }));

        const absentStudents = session.records
          .filter(record => !record.isPresent)
          .map(record => ({
            id: record.studentId,
            name: record.studentName,
            rollNumber: record.rollNumber
          }));

        return {
          id: session._id,
          subject: session.subject,
          section: session.section,
          sessionType: session.sessionType,
          hours: session.hours,
          date: session.date,
          totalStudents: session.totalStudents,
          presentStudents: session.presentStudents,
          absentStudents: session.absentStudents,
          attendancePercentage: session.totalStudents > 0 
            ? Math.round((session.presentStudents / session.totalStudents) * 100) 
            : 0,
          createdAt: session.createdAt,
          // Detailed student lists
          presentStudentsList: presentStudents,
          absentStudentsList: absentStudents
        };
      })
    });
    
  } catch (error) {
    console.error('Get attendance reports error:', error);
    res.status(500).json({ message: 'Failed to get attendance reports' });
  }
}
